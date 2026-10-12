export const DOCKER_HOST_UNSET =
  "DOCKER_HOST is not set. Proxmox VE 9.2 has no Docker API. Install Docker on a VM or LXC, publish the Engine API on the tailnet, and set DOCKER_HOST (for example tcp://100.x.y.z:2375).";

const DOCKER_UNIX =
  "DOCKER_HOST unix sockets are not supported in v1. Point DOCKER_HOST at the Docker Engine TCP API on the VM or LXC (for example tcp://100.x.y.z:2375) from a machine on the tailnet.";

type FetchInit = {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
};

type FetchResponse = {
  status: number;
  text: () => Promise<string>;
};

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

export type DockerCreateInput = {
  image: string;
  name: string;
  ports?: string[];
  env?: string[];
};

type ListedContainer = {
  id?: string;
  names?: string[];
  image?: string;
  state?: string;
  status?: string;
  ports?: unknown;
};

function splitImage(image: string): { fromImage: string; tag: string } {
  if (image.includes("@")) {
    throw new Error("Image digests are not supported in v1. Pass a name:tag.");
  }
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  if (colon > slash) {
    return { fromImage: image.slice(0, colon), tag: image.slice(colon + 1) };
  }
  return { fromImage: image, tag: "latest" };
}

function portBindings(ports: string[]): {
  exposed: Record<string, Record<string, never>>;
  bindings: Record<string, Array<{ HostPort: string }>>;
} {
  const exposed: Record<string, Record<string, never>> = {};
  const bindings: Record<string, Array<{ HostPort: string }>> = {};
  for (const spec of ports) {
    const mapped = /^(\d{1,5}):(\d{1,5})(?:\/(tcp|udp))?$/.exec(spec);
    const plain = /^(\d{1,5})(?:\/(tcp|udp))?$/.exec(spec);
    const match = mapped ?? plain;
    if (!match) {
      throw new Error('Each port must look like "8080:80" or "8080:80/tcp".');
    }
    const hostPort = mapped ? match[1] : match[1];
    const containerPort = mapped ? match[2] : match[1];
    const proto = (mapped ? match[3] : match[2]) || "tcp";
    const key = `${containerPort}/${proto}`;
    exposed[key] = {};
    bindings[key] = [{ HostPort: hostPort }];
  }
  return { exposed, bindings };
}

export class DockerClient {
  constructor(
    private readonly dockerHost: string | undefined,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {}

  async list(): Promise<ListedContainer[]> {
    const rows = (await this.request("GET", "/containers/json", { query: { all: "1" } })) as Array<{
      Id?: string;
      Names?: string[];
      Image?: string;
      State?: string;
      Status?: string;
      Ports?: unknown;
    }>;
    return (rows ?? []).map((row) => ({
      id: row.Id,
      names: row.Names,
      image: row.Image,
      state: row.State,
      status: row.Status,
      ports: row.Ports,
    }));
  }

  async start(id: string): Promise<{ id: string; action: "start" }> {
    await this.request("POST", `/containers/${encodeURIComponent(id)}/start`);
    return { id, action: "start" };
  }

  async stop(id: string): Promise<{ id: string; action: "stop" }> {
    await this.request("POST", `/containers/${encodeURIComponent(id)}/stop`, { query: { t: "10" } });
    return { id, action: "stop" };
  }

  async create(input: DockerCreateInput): Promise<{ id: string; name: string; image: string; warnings: unknown[] }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.name)) {
      throw new Error("Container name must start with a letter or digit and use only letters, digits, ., _, or -.");
    }
    for (const entry of input.env ?? []) {
      if (entry.includes("\n") || entry.includes("\r") || !entry.includes("=")) {
        throw new Error("Each env entry must be KEY=value with no newlines.");
      }
    }
    const { fromImage, tag } = splitImage(input.image);
    await this.request("POST", "/images/create", {
      query: { fromImage, tag },
      timeoutMs: 180_000,
    });
    const { exposed, bindings } = portBindings(input.ports ?? []);
    const created = (await this.request("POST", "/containers/create", {
      query: { name: input.name },
      json: {
        Image: input.image,
        Env: input.env ?? [],
        ExposedPorts: exposed,
        HostConfig: { PortBindings: bindings },
      },
    })) as { Id?: string; Warnings?: unknown[] };
    if (!created.Id) {
      throw new Error("Docker Engine API create returned no container id.");
    }
    await this.request("POST", `/containers/${encodeURIComponent(created.Id)}/start`);
    return {
      id: created.Id,
      name: input.name,
      image: input.image,
      warnings: created.Warnings ?? [],
    };
  }

  private root(): string {
    const raw = this.dockerHost?.trim();
    if (!raw) throw new Error(DOCKER_HOST_UNSET);
    if (raw.startsWith("unix://")) throw new Error(DOCKER_UNIX);
    if (raw.startsWith("tcp://")) return `http://${raw.slice("tcp://".length)}`.replace(/\/+$/, "");
    if (raw.startsWith("http://") || raw.startsWith("https://")) return raw.replace(/\/+$/, "");
    throw new Error("DOCKER_HOST must be tcp://host:port, http://host:port, or https://host:port.");
  }

  private async request(
    method: string,
    path: string,
    options: { query?: Record<string, string>; json?: unknown; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const url = new URL(path, `${this.root()}/`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = { Accept: "application/json" };
    let body: string | undefined;
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    }
    const response = await this.fetchImpl(url.toString(), {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    const text = await response.text();
    const success = response.status === 304 || (response.status >= 200 && response.status < 300);
    if (path === "/images/create") {
      if (!success) {
        throw new Error(`Docker Engine API ${response.status}: ${dockerMessage(text)}`);
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as { error?: string };
          if (row.error) throw new Error(`Docker Engine API image pull: ${row.error}`);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("Docker Engine API")) throw error;
        }
      }
      return null;
    }
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text;
      }
    }
    if (!success) {
      const message =
        parsed && typeof parsed === "object" && parsed !== null && "message" in parsed
          ? String((parsed as { message: unknown }).message)
          : text.slice(0, 500);
      throw new Error(`Docker Engine API ${response.status}: ${message || "request failed"}`);
    }
    return parsed;
  }
}

function dockerMessage(text: string): string {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { message?: string; error?: string };
      if (row.message || row.error) return row.message || row.error || "request failed";
    } catch {
      return line.slice(0, 500);
    }
  }
  return text.slice(0, 500) || "request failed";
}
