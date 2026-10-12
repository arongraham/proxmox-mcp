import { Agent, fetch as undiciFetch } from "undici";

const REQUEST_TIMEOUT_MS = 30_000;
const TASK_TIMEOUT_MS = 120_000;
const POWER_TIMEOUT_MS = 90_000;

export class ProxmoxApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ProxmoxApiError";
  }
}

export class SdnNotConfiguredError extends Error {
  constructor() {
    super(
      "SDN is not configured on this Proxmox VE 9.2 node. VNets (VPCs) need Datacenter → SDN with at least one zone. Classic bridges and VLANs are still available from network_list.",
    );
    this.name = "SdnNotConfiguredError";
  }
}

type FetchInit = {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
};

type FetchResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

export type ProxmoxClientOptions = {
  host: string;
  tokenId: string;
  tokenSecret: string;
  tlsVerify?: boolean;
  defaultNode?: string;
  fetchImpl?: FetchLike;
};

type Query = Record<string, string | number | boolean | undefined>;
type Form = Record<string, string | number | boolean | undefined>;

type TaskStatus = {
  status?: string;
  exitstatus?: string;
  upid?: string;
};

export type QemuCreateInput = {
  name: string;
  vmid?: number;
  node?: string;
  cores?: number;
  memoryMb?: number;
  diskGb?: number;
  bridge?: string;
  storage?: string;
  iso?: string;
  templateVmid?: number;
  cloudInit?: boolean;
  start?: boolean;
  ciUser?: string;
  sshKeys?: string;
  ipconfig0?: string;
};

const TLS_HINT =
  "The stock Proxmox VE 9.2 certificate does not match a Tailscale MagicDNS name or a 100.x address. Install a certificate for that name, or set PROXMOX_TLS_VERIFY=false only while this client stays on the tailnet.";

function assertVmid(vmid: number): void {
  if (!Number.isInteger(vmid) || vmid < 100 || vmid > 999_999_999) {
    throw new Error(`vmid must be an integer from 100 to 999999999. Got ${String(vmid)}.`);
  }
}

function assertToken(label: string, value: string, pattern: RegExp): void {
  if (!pattern.test(value)) {
    throw new Error(`${label} has unsupported characters.`);
  }
}

function isoVolid(iso: string): string {
  const volid = iso.includes(":") ? iso : `local:iso/${iso}`;
  assertToken("iso", volid, /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/);
  return volid;
}

function sdnMissing(status: number, message: string): boolean {
  const text = message.toLowerCase();
  return (
    status === 501 ||
    text.includes("not implemented") ||
    text.includes("no such file") ||
    text.includes("not configured") ||
    text.includes("sdn feature is not enabled")
  );
}

function proxmoxMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback.slice(0, 500);
  const record = payload as { message?: unknown; errors?: unknown };
  const parts: string[] = [];
  if (typeof record.message === "string" && record.message.trim()) {
    parts.push(record.message.trim());
  }
  if (record.errors && typeof record.errors === "object") {
    for (const [key, value] of Object.entries(record.errors as Record<string, unknown>)) {
      parts.push(`${key}: ${String(value)}`);
    }
  }
  return (parts.join(" — ") || fallback).slice(0, 800);
}

function isTlsFailure(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String(error.cause)}` : String(error);
  return /certificate|altname|self[- ]signed|unable to verify|UNABLE_TO_VERIFY|ERR_TLS/i.test(text);
}

function taskNode(upid: string, fallback: string): string {
  const node = upid.split(":")[1];
  return node || fallback;
}

function configHasCloudInit(config: Record<string, unknown>): boolean {
  return Object.values(config).some((value) => typeof value === "string" && value.includes("cloudinit"));
}

function bootDisk(config: Record<string, unknown>): string | undefined {
  return Object.keys(config).find((key) => {
    if (!/^(scsi|virtio|sata)\d+$/.test(key)) return false;
    const value = config[key];
    if (typeof value !== "string") return false;
    return !value.includes("cloudinit") && !value.includes("media=cdrom");
  });
}

function storageIdFromVolume(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.split(":")[0];
  return id || undefined;
}

export class ProxmoxClient {
  private readonly host: string;
  private readonly tokenId: string;
  private readonly tokenSecret: string;
  private readonly tlsVerify: boolean;
  private readonly defaultNode?: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: ProxmoxClientOptions) {
    this.host = options.host.replace(/\/+$/, "");
    this.tokenId = options.tokenId;
    this.tokenSecret = options.tokenSecret;
    this.tlsVerify = options.tlsVerify !== false;
    this.defaultNode = options.defaultNode;
    this.fetchImpl = options.fetchImpl ?? this.boundUndici();
  }

  async version(): Promise<unknown> {
    return this.call("GET", "/version");
  }

  async clusterStatus(): Promise<unknown> {
    return this.call("GET", "/cluster/status");
  }

  async nodeStatus(node?: string): Promise<unknown> {
    const resolved = await this.resolveNode(node);
    return { node: resolved, status: await this.call("GET", `/nodes/${encodeURIComponent(resolved)}/status`) };
  }

  async listQemu(node?: string): Promise<{ node: string; guests: unknown[] }> {
    const resolved = await this.resolveNode(node);
    const guests = await this.call<unknown[]>("GET", `/nodes/${encodeURIComponent(resolved)}/qemu`);
    return { node: resolved, guests: guests ?? [] };
  }

  async getQemuConfig(vmid: number, node?: string): Promise<unknown> {
    assertVmid(vmid);
    const resolved = await this.resolveNode(node);
    return {
      node: resolved,
      vmid,
      config: await this.call("GET", this.guestPath("qemu", resolved, vmid, "/config")),
    };
  }

  async createQemu(input: QemuCreateInput): Promise<{
    node: string;
    vmid: number;
    source: "clone" | "create";
    upid: string | null;
    ignoredIso: boolean;
    warnings: string[];
    started: boolean;
  }> {
    assertToken("name", input.name, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
    const node = await this.resolveNode(input.node);
    const vmid = input.vmid ?? (await this.nextVmid());
    assertVmid(vmid);
    if (input.templateVmid !== undefined) assertVmid(input.templateVmid);
    const bridge = input.bridge ?? "vmbr0";
    const storage = input.storage ?? "local-lvm";
    assertToken("bridge", bridge, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
    assertToken("storage", storage, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
    if (input.ipconfig0 && /[\r\n]/.test(input.ipconfig0)) {
      throw new Error("ipconfig0 cannot contain newlines.");
    }
    if (input.sshKeys && /[\r]/.test(input.sshKeys)) {
      throw new Error("sshKeys cannot contain carriage returns.");
    }

    const warnings: string[] = [];
    const ignoredIso = Boolean(input.iso && input.templateVmid !== undefined);
    let upid: string | null = null;

    if (input.templateVmid !== undefined) {
      upid = await this.cloneTemplate(node, input.templateVmid, vmid, input, storage, warnings);
    } else {
      upid = await this.createFresh(node, vmid, input, bridge, storage);
    }

    let started = false;
    if (input.start) {
      try {
        await this.startQemu(vmid, node);
        started = true;
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }

    return {
      node,
      vmid,
      source: input.templateVmid !== undefined ? "clone" : "create",
      upid,
      ignoredIso,
      warnings,
      started,
    };
  }

  async startQemu(vmid: number, node?: string): Promise<unknown> {
    return this.power("qemu", "start", vmid, node, false);
  }

  async shutdownQemu(vmid: number, node?: string, timeoutSeconds = 60): Promise<unknown> {
    return this.power("qemu", "shutdown", vmid, node, false, { timeout: timeoutSeconds });
  }

  async stopQemu(vmid: number, node?: string, confirm?: boolean): Promise<unknown> {
    this.requireConfirm(
      confirm,
      `Refusing to force-stop VM ${vmid}. Pass confirm: true. Prefer qemu_shutdown unless the guest is stuck.`,
    );
    return this.power("qemu", "stop", vmid, node, true);
  }

  async deleteQemu(vmid: number, node?: string, confirm?: boolean): Promise<unknown> {
    this.requireConfirm(
      confirm,
      `Refusing to delete VM ${vmid}. Pass confirm: true. Confirmed delete removes the QEMU guest, its disks, and related backup, replication, and HA entries.`,
    );
    assertVmid(vmid);
    const resolved = await this.resolveNode(node);
    const upid = await this.call<string>("DELETE", this.guestPath("qemu", resolved, vmid), {
      query: { purge: 1, "destroy-unreferenced-disks": 1 },
    });
    const task = await this.maybeWait(resolved, upid, TASK_TIMEOUT_MS);
    return { node: resolved, vmid, upid: typeof upid === "string" ? upid : null, task };
  }

  async listLxc(node?: string): Promise<{ node: string; guests: unknown[] }> {
    const resolved = await this.resolveNode(node);
    const guests = await this.call<unknown[]>("GET", `/nodes/${encodeURIComponent(resolved)}/lxc`);
    return { node: resolved, guests: guests ?? [] };
  }

  async getLxc(vmid: number, node?: string): Promise<unknown> {
    assertVmid(vmid);
    const resolved = await this.resolveNode(node);
    const [config, status] = await Promise.all([
      this.call("GET", this.guestPath("lxc", resolved, vmid, "/config")),
      this.call("GET", this.guestPath("lxc", resolved, vmid, "/status/current")),
    ]);
    return { node: resolved, vmid, config, status };
  }

  async startLxc(vmid: number, node?: string): Promise<unknown> {
    return this.power("lxc", "start", vmid, node, false);
  }

  async shutdownLxc(vmid: number, node?: string, timeoutSeconds = 60): Promise<unknown> {
    return this.power("lxc", "shutdown", vmid, node, false, { timeout: timeoutSeconds });
  }

  async stopLxc(vmid: number, node?: string, confirm?: boolean): Promise<unknown> {
    this.requireConfirm(
      confirm,
      `Refusing to force-stop container ${vmid}. Pass confirm: true. Prefer lxc_shutdown unless the guest is stuck.`,
    );
    return this.power("lxc", "stop", vmid, node, true);
  }

  async listStorage(node?: string): Promise<unknown> {
    const resolved = await this.resolveNode(node);
    const stores = await this.call<unknown[]>("GET", `/nodes/${encodeURIComponent(resolved)}/storage`);
    return { node: resolved, stores: stores ?? [] };
  }

  async storageContent(storage: string, node?: string, content?: string): Promise<unknown> {
    assertToken("storage", storage, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
    const resolved = await this.resolveNode(node);
    const volumes = await this.call<unknown[]>(
      "GET",
      `/nodes/${encodeURIComponent(resolved)}/storage/${encodeURIComponent(storage)}/content`,
      { query: { content } },
    );
    return { node: resolved, storage, volumes: volumes ?? [] };
  }

  async listNetwork(node?: string): Promise<unknown> {
    const resolved = await this.resolveNode(node);
    const interfaces = (await this.call<Array<{ type?: string }>>(
      "GET",
      `/nodes/${encodeURIComponent(resolved)}/network`,
    )) ?? [];
    const ofType = (...types: string[]) => interfaces.filter((iface) => types.includes(iface.type ?? ""));
    return {
      node: resolved,
      bridges: ofType("bridge", "OVSBridge"),
      vlans: ofType("vlan"),
      bonds: ofType("bond", "OVSBond"),
    };
  }

  async listSdn(): Promise<{ zones: unknown; vnets: unknown; note: string }> {
    try {
      const zones = await this.call("GET", "/cluster/sdn/zones");
      const vnets = await this.call("GET", "/cluster/sdn/vnets");
      return {
        zones: zones ?? [],
        vnets: vnets ?? [],
        note: "VNets are the VPC feature. Attach a guest NIC by setting its bridge to the vnet id.",
      };
    } catch (error) {
      if (error instanceof ProxmoxApiError && sdnMissing(error.status, error.message)) {
        throw new SdnNotConfiguredError();
      }
      throw error;
    }
  }

  private requireConfirm(confirm: boolean | undefined, message: string): void {
    if (confirm !== true) throw new Error(message);
  }

  private async power(
    kind: "qemu" | "lxc",
    action: "start" | "shutdown" | "stop",
    vmid: number,
    node: string | undefined,
    confirmed: boolean,
    query?: Query,
  ): Promise<unknown> {
    if (!confirmed && action === "stop") {
      throw new Error("Force-stop requires confirm: true.");
    }
    assertVmid(vmid);
    const resolved = await this.resolveNode(node);
    const upid = await this.call<string>("POST", this.guestPath(kind, resolved, vmid, `/status/${action}`), {
      query,
    });
    const task = await this.maybeWait(resolved, upid, POWER_TIMEOUT_MS);
    return { node: resolved, vmid, action, upid: typeof upid === "string" ? upid : null, task };
  }

  private async createFresh(
    node: string,
    vmid: number,
    input: QemuCreateInput,
    bridge: string,
    storage: string,
  ): Promise<string | null> {
    const cloudInit = input.cloudInit ?? !input.iso;
    const diskGb = input.diskGb ?? 16;
    const body: Form = {
      vmid,
      name: input.name,
      cores: input.cores ?? 2,
      memory: input.memoryMb ?? 2048,
      ostype: "l26",
      scsihw: "virtio-scsi-pci",
      scsi0: `${storage}:${diskGb}`,
      net0: `virtio,bridge=${bridge}`,
      agent: "enabled=1",
    };
    if (input.iso) {
      body.ide0 = isoVolid(input.iso);
      body.boot = cloudInit ? "order=scsi0;ide0" : "order=ide0;scsi0";
    } else {
      body.boot = "order=scsi0";
    }
    if (cloudInit) {
      body.ide2 = `${storage}:cloudinit`;
      body.serial0 = "socket";
      body.vga = "serial0";
    }
    if (input.ciUser) body.ciuser = input.ciUser;
    if (input.sshKeys) body.sshkeys = input.sshKeys;
    if (input.ipconfig0) body.ipconfig0 = input.ipconfig0;

    const upid = await this.call<string>("POST", `/nodes/${encodeURIComponent(node)}/qemu`, { body });
    await this.maybeWait(node, upid, TASK_TIMEOUT_MS);
    return typeof upid === "string" ? upid : null;
  }

  private async cloneTemplate(
    node: string,
    templateVmid: number,
    vmid: number,
    input: QemuCreateInput,
    storage: string,
    warnings: string[],
  ): Promise<string | null> {
    const upid = await this.call<string>(
      "POST",
      this.guestPath("qemu", node, templateVmid, "/clone"),
      {
        body: {
          newid: vmid,
          name: input.name,
          full: 1,
          ...(input.storage ? { storage: input.storage } : {}),
        },
      },
    );
    await this.maybeWait(node, upid, TASK_TIMEOUT_MS);

    const config = (await this.call<Record<string, unknown>>(
      "GET",
      this.guestPath("qemu", node, vmid, "/config"),
    )) ?? {};
    const cloudInit = input.cloudInit ?? true;
    const diskStorage = input.storage ?? storageIdFromVolume(config[bootDisk(config) ?? ""]) ?? storage;
    const updates: Form = {};
    if (input.cores !== undefined) updates.cores = input.cores;
    if (input.memoryMb !== undefined) updates.memory = input.memoryMb;
    if (input.bridge !== undefined) updates.net0 = `virtio,bridge=${input.bridge}`;
    if (input.ciUser) updates.ciuser = input.ciUser;
    if (input.sshKeys) updates.sshkeys = input.sshKeys;
    if (input.ipconfig0) updates.ipconfig0 = input.ipconfig0;
    if (cloudInit && !configHasCloudInit(config)) updates.ide2 = `${diskStorage}:cloudinit`;
    if (Object.keys(updates).length > 0) {
      const configUpid = await this.call("POST", this.guestPath("qemu", node, vmid, "/config"), {
        body: updates,
      });
      await this.maybeWait(node, configUpid, TASK_TIMEOUT_MS);
    }

    if (input.diskGb !== undefined) {
      const disk = bootDisk(config);
      if (!disk) {
        warnings.push("Clone succeeded but no scsi, virtio, or sata disk was found to resize.");
      } else {
        try {
          const resizeUpid = await this.call("PUT", this.guestPath("qemu", node, vmid, "/resize"), {
            body: { disk, size: `${input.diskGb}G` },
          });
          await this.maybeWait(node, resizeUpid, TASK_TIMEOUT_MS);
        } catch (error) {
          warnings.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    return typeof upid === "string" ? upid : null;
  }

  private async nextVmid(): Promise<number> {
    const id = await this.call<string | number>("GET", "/cluster/nextid");
    const vmid = Number(id);
    if (!Number.isInteger(vmid)) {
      throw new Error("Proxmox API /cluster/nextid returned an unexpected value.");
    }
    return vmid;
  }

  private async resolveNode(node?: string): Promise<string> {
    if (node) {
      assertToken("node", node, /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/);
      return node;
    }
    if (this.defaultNode) {
      assertToken("node", this.defaultNode, /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/);
      return this.defaultNode;
    }
    const nodes = (await this.call<Array<{ node?: string; type?: string }>>("GET", "/nodes")) ?? [];
    const names = nodes
      .filter((entry) => !entry.type || entry.type === "node")
      .map((entry) => entry.node)
      .filter((name): name is string => Boolean(name));
    if (names.length === 1) return names[0];
    throw new Error(
      `Pass node or set PROXMOX_NODE. This cluster does not have exactly one node (${names.join(", ") || "none"}).`,
    );
  }

  private guestPath(kind: "qemu" | "lxc", node: string, vmid: number, rest = ""): string {
    return `/nodes/${encodeURIComponent(node)}/${kind}/${vmid}${rest}`;
  }

  private async maybeWait(node: string, upid: unknown, timeoutMs: number): Promise<TaskStatus | null> {
    if (typeof upid !== "string" || upid.length === 0) return null;
    return this.waitForTask(taskNode(upid, node), upid, timeoutMs);
  }

  private async waitForTask(node: string, upid: string, timeoutMs: number): Promise<TaskStatus> {
    const started = Date.now();
    for (;;) {
      const task = (await this.call<TaskStatus>(
        "GET",
        `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`,
      )) ?? {};
      if (task.status === "stopped") {
        if (task.exitstatus && task.exitstatus !== "OK") {
          throw new ProxmoxApiError(`Proxmox API task failed (${task.exitstatus})`, 500);
        }
        return task;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Proxmox API task timed out after ${timeoutMs}ms.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  private async call<T>(method: string, path: string, options: { query?: Query; body?: Form } = {}): Promise<T> {
    const url = new URL(`${this.host}/api2/json${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `PVEAPIToken=${this.tokenId}=${this.tokenSecret}`,
    };
    let body: string | undefined;
    if (options.body) {
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(options.body)) {
        if (value === undefined) continue;
        form.set(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
      }
      body = form.toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    let response: FetchResponse;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.tlsVerify && isTlsFailure(error)) {
        throw new Error(`Proxmox API request failed: ${message}. ${TLS_HINT}`);
      }
      throw new Error(`Proxmox API request failed: ${message}`);
    }

    if (response.status >= 300 && response.status < 400) {
      throw new ProxmoxApiError(`Proxmox API ${response.status}: refused redirect`, response.status);
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = null;
      }
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ProxmoxApiError(
        `Proxmox API ${response.status}: ${proxmoxMessage(parsed, text || response.status.toString())}`,
        response.status,
      );
    }
    if (!parsed || typeof parsed !== "object" || !("data" in parsed)) {
      return undefined as T;
    }
    return (parsed as { data: T }).data;
  }

  private boundUndici(): FetchLike {
    const agent = new Agent({
      connect: { rejectUnauthorized: this.tlsVerify },
    });
    return async (url, init) => {
      const response = await undiciFetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: init.signal,
        redirect: "manual",
        dispatcher: agent,
      });
      return {
        ok: response.ok,
        status: response.status,
        text: () => response.text(),
      };
    };
  }
}
