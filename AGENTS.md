# Operating rules

This repo talks to one Proxmox VE 9.2.2 node. The API is HTTPS on port 8006. Auth is an API token header, `Authorization: PVEAPIToken=USER@REALM!TOKENID=SECRET`.

## Network

- `PROXMOX_HOST` is a Tailscale MagicDNS name or the node's 100.x address, for example `https://pve.<tailnet>.ts.net:8006` or `https://100.x.y.z:8006`.
- Run the MCP on a machine that is already on that tailnet. Do not join Tailscale from a cloud build VM. Do not ask for a Tailscale auth key.
- Do not invent a hostname. Use the placeholders until the operator fills them in.

## TLS

- Leave `PROXMOX_TLS_VERIFY` at its default, `true`. Do not disable verification in code.
- The stock Proxmox certificate matches the node's own hostname, not MagicDNS and not the 100.x address. Verification fails until a certificate for that name is installed.
- Prefer installing the certificate. `PROXMOX_TLS_VERIFY=false` is only for a client that stays on the tailnet, and only when the operator accepts that.

## Safety

- Never print `PROXMOX_TOKEN_SECRET`, the Authorization header, or the contents of `.env`.
- Never hardcode a host, token, or password.
- Prefer `qemu_shutdown` and `lxc_shutdown`. `qemu_stop` and `lxc_stop` are force power-offs and require `confirm: true`.
- `qemu_delete` requires `confirm: true`. It removes the guest, its disks, and related backup, replication, and HA entries.
- Prefer a template clone over an ISO install when a template exists.

## Words

- VMs are QEMU/KVM guests (`qemu_*`).
- VPCs are SDN vnets (`sdn_list`). If that tool says SDN is not configured, use `network_list` for classic bridges and VLANs.
- Docker is not part of Proxmox VE. `docker_*` uses the Docker Engine API on `DOCKER_HOST` (a VM or LXC). If that variable is unset, say so and do not invent a PVE Docker API.
