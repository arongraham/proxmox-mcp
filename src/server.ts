import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { DockerClient } from "./docker.js";
import { ProxmoxClient } from "./proxmox.js";

const nodeField = z.string().optional().describe("Node name. Defaults to PROXMOX_NODE, or the only node.");
const vmidField = z.number().int().describe("Guest id (VMID).");

const INSTRUCTIONS = [
  "This server manages one Proxmox VE 9.2.2 node. The API is https on port 8006 over Tailscale (MagicDNS or a 100.x address).",
  "VMs are QEMU/KVM guests. VPCs are SDN vnets from sdn_list. Classic bridges and VLANs come from network_list.",
  "Prefer qemu_shutdown and lxc_shutdown. qemu_stop, lxc_stop, and qemu_delete require confirm true.",
  "Prefer cloning a template over an ISO install when a template exists.",
  "Never print the API token secret or the Authorization header.",
  "Docker is not part of Proxmox. docker_* talks to DOCKER_HOST only.",
].join(" ");

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown, secret: string) {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = raw.split(secret).join("[redacted]").replace(/PVEAPIToken=\S+/g, "PVEAPIToken=[redacted]");
  return { isError: true as const, content: [{ type: "text" as const, text: redacted }] };
}

export function createServer(config: AppConfig): McpServer {
  const proxmox = new ProxmoxClient({
    host: config.host,
    tokenId: config.tokenId,
    tokenSecret: config.tokenSecret,
    tlsVerify: config.tlsVerify,
    defaultNode: config.node,
  });
  const docker = new DockerClient(config.dockerHost);
  const server = new McpServer(
    { name: "proxmox", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );

  const handle = (work: Promise<unknown>) =>
    work.then(textResult).catch((error: unknown) => errorResult(error, config.tokenSecret));

  server.registerTool(
    "proxmox_version",
    {
      title: "Proxmox version",
      description: "GET /api2/json/version. This node is Proxmox VE 9.2.2.",
      inputSchema: z.object({}),
    },
    async () => handle(proxmox.version()),
  );

  server.registerTool(
    "proxmox_cluster_status",
    {
      title: "Cluster status",
      description: "Cluster quorum and node membership from GET /api2/json/cluster/status.",
      inputSchema: z.object({}),
    },
    async () => handle(proxmox.clusterStatus()),
  );

  server.registerTool(
    "proxmox_node_status",
    {
      title: "Node status",
      description: "CPU, memory, and uptime for the Proxmox VE 9.2 node.",
      inputSchema: z.object({ node: nodeField }),
    },
    async ({ node }) => handle(proxmox.nodeStatus(node)),
  );

  server.registerTool(
    "qemu_list",
    {
      title: "List VMs",
      description: "List QEMU/KVM virtual machines on a node. These guests are the VMs.",
      inputSchema: z.object({ node: nodeField }),
    },
    async ({ node }) => handle(proxmox.listQemu(node)),
  );

  server.registerTool(
    "qemu_get_config",
    {
      title: "Get VM config",
      description: "Read one QEMU guest config.",
      inputSchema: z.object({ vmid: vmidField, node: nodeField }),
    },
    async ({ vmid, node }) => handle(proxmox.getQemuConfig(vmid, node)),
  );

  server.registerTool(
    "qemu_create",
    {
      title: "Create VM",
      description:
        "Create a QEMU guest or full-clone a template. Cloud-init friendly. Prefer templateVmid when a template exists. An ISO is ignored when templateVmid is set. Does not start the guest unless start is true.",
      inputSchema: z.object({
        name: z.string().describe("Guest name."),
        vmid: z.number().int().optional().describe("VMID. Omit to allocate one from /cluster/nextid."),
        node: nodeField,
        cores: z.number().int().positive().optional().describe("vCPU cores. Sockets stay at 1. Default 2 on a new disk."),
        memoryMb: z.number().int().positive().optional().describe("Memory in MB. Default 2048 on a new disk."),
        diskGb: z.number().int().positive().optional().describe("Disk size in GB. Default 16 on a new disk. On clone, grows the boot disk."),
        bridge: z.string().optional().describe("Classic bridge or SDN vnet id. Default vmbr0 on a new disk."),
        storage: z.string().optional().describe("Storage id for a new disk or full clone. Default local-lvm."),
        iso: z.string().optional().describe("ISO volid such as local:iso/name.iso, or a file name under local:iso/."),
        templateVmid: z.number().int().optional().describe("Template VMID to full-clone. Preferred over iso."),
        cloudInit: z.boolean().optional().describe("Attach a cloud-init drive. Default true, except for an ISO install."),
        ciUser: z.string().optional().describe("cloud-init user."),
        sshKeys: z.string().optional().describe("cloud-init SSH public keys."),
        ipconfig0: z.string().optional().describe('cloud-init ipconfig0, for example "ip=dhcp".'),
        start: z.boolean().optional().describe("Start the guest after it exists. Default false."),
      }),
    },
    async (input) => handle(proxmox.createQemu(input)),
  );

  server.registerTool(
    "qemu_start",
    {
      title: "Start VM",
      description: "Start a QEMU guest.",
      inputSchema: z.object({ vmid: vmidField, node: nodeField }),
    },
    async ({ vmid, node }) => handle(proxmox.startQemu(vmid, node)),
  );

  server.registerTool(
    "qemu_shutdown",
    {
      title: "Shutdown VM",
      description: "Graceful ACPI shutdown of a QEMU guest. Prefer this over qemu_stop.",
      inputSchema: z.object({
        vmid: vmidField,
        node: nodeField,
        timeoutSeconds: z.number().int().positive().optional().describe("Guest shutdown grace period. Default 60."),
      }),
    },
    async ({ vmid, node, timeoutSeconds }) => handle(proxmox.shutdownQemu(vmid, node, timeoutSeconds)),
  );

  server.registerTool(
    "qemu_stop",
    {
      title: "Force-stop VM",
      description: "Force power off a QEMU guest. Refuses unless confirm is true. Prefer qemu_shutdown.",
      inputSchema: z.object({
        vmid: vmidField,
        node: nodeField,
        confirm: z.boolean().optional().describe("Must be true, or the tool returns an error and does not power off."),
      }),
    },
    async ({ vmid, node, confirm }) => handle(proxmox.stopQemu(vmid, node, confirm)),
  );

  server.registerTool(
    "qemu_delete",
    {
      title: "Delete VM",
      description:
        "Destroy a QEMU guest, its disks, unreferenced disks owned by that VMID, and related backup, replication, and HA entries. Refuses unless confirm is true.",
      inputSchema: z.object({
        vmid: vmidField,
        node: nodeField,
        confirm: z.boolean().optional().describe("Must be true, or the tool returns an error and does not delete anything."),
      }),
    },
    async ({ vmid, node, confirm }) => handle(proxmox.deleteQemu(vmid, node, confirm)),
  );

  server.registerTool(
    "lxc_list",
    {
      title: "List LXC",
      description: "List LXC containers on a node.",
      inputSchema: z.object({ node: nodeField }),
    },
    async ({ node }) => handle(proxmox.listLxc(node)),
  );

  server.registerTool(
    "lxc_get",
    {
      title: "Get LXC",
      description: "LXC config plus current status.",
      inputSchema: z.object({ vmid: vmidField, node: nodeField }),
    },
    async ({ vmid, node }) => handle(proxmox.getLxc(vmid, node)),
  );

  server.registerTool(
    "lxc_start",
    {
      title: "Start LXC",
      description: "Start an LXC container.",
      inputSchema: z.object({ vmid: vmidField, node: nodeField }),
    },
    async ({ vmid, node }) => handle(proxmox.startLxc(vmid, node)),
  );

  server.registerTool(
    "lxc_shutdown",
    {
      title: "Shutdown LXC",
      description: "Graceful shutdown of an LXC container. Prefer this over lxc_stop.",
      inputSchema: z.object({
        vmid: vmidField,
        node: nodeField,
        timeoutSeconds: z.number().int().positive().optional().describe("Guest shutdown grace period. Default 60."),
      }),
    },
    async ({ vmid, node, timeoutSeconds }) => handle(proxmox.shutdownLxc(vmid, node, timeoutSeconds)),
  );

  server.registerTool(
    "lxc_stop",
    {
      title: "Force-stop LXC",
      description: "Force stop an LXC container. Refuses unless confirm is true. Prefer lxc_shutdown.",
      inputSchema: z.object({
        vmid: vmidField,
        node: nodeField,
        confirm: z.boolean().optional().describe("Must be true, or the tool returns an error and does not stop the container."),
      }),
    },
    async ({ vmid, node, confirm }) => handle(proxmox.stopLxc(vmid, node, confirm)),
  );

  server.registerTool(
    "storage_list",
    {
      title: "List storage",
      description: "List storage configured on a node.",
      inputSchema: z.object({ node: nodeField }),
    },
    async ({ node }) => handle(proxmox.listStorage(node)),
  );

  server.registerTool(
    "storage_content",
    {
      title: "List storage content",
      description: "List volumes on one store. Use content iso or vztmpl for ISOs and container templates.",
      inputSchema: z.object({
        storage: z.string().describe("Storage id, for example local or local-lvm."),
        node: nodeField,
        content: z.string().optional().describe("Optional filter: iso, vztmpl, images, backup, or rootdir."),
      }),
    },
    async ({ storage, node, content }) => handle(proxmox.storageContent(storage, node, content)),
  );

  server.registerTool(
    "network_list",
    {
      title: "List bridges and VLANs",
      description:
        "Classic node network from GET /nodes/{node}/network: bridges, VLANs, and bonds. This is not SDN. VNets (VPCs) are sdn_list.",
      inputSchema: z.object({ node: nodeField }),
    },
    async ({ node }) => handle(proxmox.listNetwork(node)),
  );

  server.registerTool(
    "sdn_list",
    {
      title: "List SDN zones and vnets",
      description:
        "List SDN zones and vnets on Proxmox VE 9.2 (GET /cluster/sdn/zones and /cluster/sdn/vnets). VNets are the VPC feature. Returns a clear error when SDN is not configured.",
      inputSchema: z.object({}),
    },
    async () => handle(proxmox.listSdn()),
  );

  server.registerTool(
    "docker_list",
    {
      title: "List Docker containers",
      description:
        "List containers via the Docker Engine API on DOCKER_HOST. Proxmox has no Docker API. If DOCKER_HOST is unset, returns setup steps instead of calling Proxmox.",
      inputSchema: z.object({}),
    },
    async () => handle(docker.list()),
  );

  server.registerTool(
    "docker_start",
    {
      title: "Start Docker container",
      description: "Start a container by name or id on DOCKER_HOST.",
      inputSchema: z.object({ id: z.string().describe("Container name or id.") }),
    },
    async ({ id }) => handle(docker.start(id)),
  );

  server.registerTool(
    "docker_stop",
    {
      title: "Stop Docker container",
      description:
        "Docker Engine stop (SIGTERM, then SIGKILL after 10s) on DOCKER_HOST. This is not a Proxmox force-stop and does not take confirm.",
      inputSchema: z.object({ id: z.string().describe("Container name or id.") }),
    },
    async ({ id }) => handle(docker.stop(id)),
  );

  server.registerTool(
    "docker_create",
    {
      title: "Create Docker container",
      description: "Pull an image if needed, create a container, and start it on DOCKER_HOST.",
      inputSchema: z.object({
        image: z.string().describe("Image name:tag, for example nginx:alpine."),
        name: z.string().describe("Container name."),
        ports: z.array(z.string()).optional().describe('Published ports, for example ["8080:80"].'),
        env: z.array(z.string()).optional().describe('Environment entries, for example ["FOO=bar"].'),
      }),
    },
    async (input) => handle(docker.create(input)),
  );

  return server;
}
