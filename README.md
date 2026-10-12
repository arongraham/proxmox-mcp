# Proxmox MCP

stdio MCP server for one [Proxmox VE 9.2.2](https://pve.proxmox.com/pve-docs/) node. A Cursor agent calls the official REST API at `https://<host>:8006/api2/json`. There is no Proxmox wrapper library.

The API is reached over **Tailscale**, not a public URL and not LAN-only. Run this process on a machine that is already on that tailnet.

## Words

| You say | On this node |
| --- | --- |
| VM | QEMU/KVM guest. Tools: `qemu_*`. |
| VPC | SDN vnet. Tool: `sdn_list` (`GET /cluster/sdn/vnets`). Attach a NIC by using the vnet id as the bridge. |
| Classic network | Node bridges, VLANs, and bonds. Tool: `network_list` (`GET /nodes/{node}/network`). |
| Docker | Not part of Proxmox. A Docker Engine API on `DOCKER_HOST`, usually a VM or LXC. |

## Requirements

- Node.js 22 or newer
- A Proxmox VE 9.2.2 API token
- The MCP host joined to the same tailnet as the node

`npm test` does not need the node. It uses a local mock.

## 1. Create a least-privilege token

Use a dedicated user in the Proxmox VE authentication realm, privilege separation on, and the same role on both the user and the token. Effective token rights are the intersection of the two.

In the web UI (`https://pve.<tailnet>.ts.net:8006`):

1. **Datacenter → Permissions → Users → Add.** User name `cursor`, realm **Proxmox VE authentication server**. Set a password. The MCP does not use that password.
2. **Datacenter → Permissions → Roles → Create.** Custom roles cannot start with `PVE`.
3. **Datacenter → Permissions → API Tokens → Add.** User `cursor@pve`, Token ID `cursor`, leave **Privilege Separation** enabled. Copy the secret once into `PROXMOX_TOKEN_SECRET`. It is not shown again.
4. **Datacenter → Permissions → Add.** Path `/`. Add the role twice: once for user `cursor@pve`, once for token `cursor@pve!cursor`.

Read-only role `CursorRead`:

```
VM.Audit
Datastore.Audit
SDN.Audit
Sys.Audit
```

Admin role `CursorAdmin` (what the write tools need):

```
VM.Allocate
VM.Audit
VM.Clone
VM.Config.CDROM
VM.Config.CPU
VM.Config.Cloudinit
VM.Config.Disk
VM.Config.HWType
VM.Config.Memory
VM.Config.Network
VM.Config.Options
VM.PowerMgmt
Datastore.AllocateSpace
Datastore.Audit
SDN.Audit
SDN.Use
Sys.Audit
```

`CursorAdmin` can create, clone, configure, power, and delete guests, allocate disk space, and read SDN and node networks. It cannot change permissions, rewrite SDN, or edit host network config (`Sys.Modify` is omitted on purpose).

The same roles from a shell on the node:

```sh
pveum user add cursor@pve --comment "Cursor MCP"
pveum role add CursorRead --privs "VM.Audit Datastore.Audit SDN.Audit Sys.Audit"
pveum role add CursorAdmin --privs "VM.Allocate VM.Audit VM.Clone VM.Config.CDROM VM.Config.CPU VM.Config.Cloudinit VM.Config.Disk VM.Config.HWType VM.Config.Memory VM.Config.Network VM.Config.Options VM.PowerMgmt Datastore.AllocateSpace Datastore.Audit SDN.Audit SDN.Use Sys.Audit"
pveum user token add cursor@pve cursor --privsep 1
pveum acl modify / --user cursor@pve --role CursorAdmin
pveum acl modify / --token 'cursor@pve!cursor' --role CursorAdmin
```

`pveum user token add` prints the secret once. Do not paste it into chat or commit it.

## 2. Configure

```sh
cp .env.example .env
```

| Variable | Value |
| --- | --- |
| `PROXMOX_HOST` | `https://pve.<tailnet>.ts.net:8006` or `https://100.x.y.z:8006` |
| `PROXMOX_TOKEN_ID` | `cursor@pve!cursor` |
| `PROXMOX_TOKEN_SECRET` | the secret from token creation |
| `PROXMOX_NODE` | optional node name; otherwise the only node is used |
| `PROXMOX_TLS_VERIFY` | `true` (default). Do not flip the code default. |
| `DOCKER_HOST` | optional, for example `tcp://100.x.y.z:2375` |

Replace every placeholder. This repo does not know the tailnet name or the node name.

### TLS

The stock Proxmox certificate is for the node's own hostname. It does not match a MagicDNS name or a 100.x address, so a client that verifies TLS fails until one of these is true:

1. Install a certificate whose name is the MagicDNS name (preferred). On the node: **Node → System → Certificates**, and upload a cert for that name.
2. Set `PROXMOX_TLS_VERIFY=false` only while the MCP process stays on the tailnet.

### Where this process runs

The MCP is stdio. Cursor starts it on the machine where Cursor is running. That machine must already be on the tailnet. A cloud build VM is not on it. Do not install Tailscale there and do not request an auth key.

Do not publish port 8006 on the public internet. LAN-only would require the MCP host to be on that LAN. This node is reached over Tailscale instead.

## 3. Run

```sh
npm install
npm test
npm run build
node --env-file=.env dist/index.js
```

The server speaks MCP on stdin/stdout and logs `proxmox-mcp stdio ready` on stderr. It does not open a port.

Point Cursor at the built file. Put this in `~/.cursor/mcp.json` (or a gitignored `.cursor/mcp.json`). Replace the path, host, node name, and secret.

```json
{
  "mcpServers": {
    "proxmox": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/dist/index.js"],
      "env": {
        "PROXMOX_HOST": "https://pve.<tailnet>.ts.net:8006",
        "PROXMOX_TOKEN_ID": "cursor@pve!cursor",
        "PROXMOX_TOKEN_SECRET": "paste-the-secret",
        "PROXMOX_NODE": "your-node-name",
        "PROXMOX_TLS_VERIFY": "true"
      }
    }
  }
}
```

Add `DOCKER_HOST` to that `env` block only after the Docker host exists. Until then the Docker tools return a short setup error.

## Docker host

Proxmox VE 9.2 has no Docker API. `docker_*` talks to the Engine API on `DOCKER_HOST`.

Create that host later, from Cursor or the web UI:

1. Create a VM (or an LXC) on the node.
2. Install Docker Engine inside that guest.
3. Publish the API on the guest's tailnet address only, not on a public interface. `tcp://` is plain HTTP. That is acceptable on the tailnet. Prefer mutual TLS (`https://`) when you have certificates. Do not publish port 2375 on the internet.
4. Set `DOCKER_HOST=tcp://100.x.y.z:2375` using that guest's 100.x address. The guest must be reachable from the machine that runs the MCP (the guest runs Tailscale, or the node routes to it).
5. Call `docker_list`.

`unix://` sockets are not supported in v1. If systemd already owns the Docker socket, a `hosts` entry in `daemon.json` can stop the service from starting. Put the TCP listener in the systemd drop-in instead.

## Tools

| Tool | API |
| --- | --- |
| `proxmox_version` | `GET /version` |
| `proxmox_cluster_status` | `GET /cluster/status` |
| `proxmox_node_status` | `GET /nodes/{node}/status` |
| `qemu_list` | `GET /nodes/{node}/qemu` |
| `qemu_get_config` | `GET /nodes/{node}/qemu/{vmid}/config` |
| `qemu_create` | `POST /nodes/{node}/qemu`, or `POST .../qemu/{vmid}/clone` for a full clone |
| `qemu_start` | `POST .../status/start` |
| `qemu_shutdown` | `POST .../status/shutdown` |
| `qemu_stop` | `POST .../status/stop` (`confirm: true`) |
| `qemu_delete` | `DELETE .../qemu/{vmid}?purge=1&destroy-unreferenced-disks=1` (`confirm: true`) |
| `lxc_list` | `GET /nodes/{node}/lxc` |
| `lxc_get` | config and `GET .../status/current` |
| `lxc_start` | `POST .../status/start` |
| `lxc_shutdown` | `POST .../status/shutdown` |
| `lxc_stop` | `POST .../status/stop` (`confirm: true`) |
| `storage_list` | `GET /nodes/{node}/storage` |
| `storage_content` | `GET /nodes/{node}/storage/{storage}/content` |
| `network_list` | bridges, VLANs, and bonds |
| `sdn_list` | `GET /cluster/sdn/zones` and `GET /cluster/sdn/vnets` |
| `docker_list` | `GET /containers/json` |
| `docker_start` | `POST /containers/{id}/start` |
| `docker_stop` | `POST /containers/{id}/stop` |
| `docker_create` | image pull, `POST /containers/create`, then start |

Paths are under `/api2/json`. These are the Proxmox VE 9.2 routes: QEMU create/clone/resize/destroy from the current `qm` API, and SDN zones and vnets from the current `/cluster/sdn` index. Auth is the `PVEAPIToken` header.

`qemu_create` defaults to a virtio-scsi disk, a cloud-init drive, and the PVE 9.2 CPU default (the CPU type is not overridden). Pass `templateVmid` to full-clone instead. An ISO is ignored when a template is set. The guest is not started unless `start` is true.

`qemu_delete`, `qemu_stop`, and `lxc_stop` no-op with an error unless `confirm` is `true`.

If SDN is not installed or not configured, `sdn_list` returns an error that says so. A 403 permission failure stays a 403.

## Not in v1

- Snapshots, backups, restore, migrate, console, and guest-agent file access
- Creating or applying SDN zones, vnets, or subnets (list only)
- Firewall, users, tokens, pools, and HA changes
- LXC create and delete
- QEMU reset, reboot, and suspend
- Docker logs, exec, remove, compose, image digests, and `unix://` sockets
- Issuing the Tailscale TLS certificate (documented, not automated)

## Tests

```sh
npm test
```

The tests mock Proxmox and Docker on `127.0.0.1`. They check the token header, QEMU list, delete-without-confirm, and the SDN-not-configured error. No tailnet and no real node.
