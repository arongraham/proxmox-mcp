import assert from "node:assert/strict";
import http from "node:http";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { after, before, describe, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { DockerClient } from "../src/docker.ts";
import { ProxmoxClient } from "../src/proxmox.ts";

type Hit = {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
};

type Mock = {
  hits: Hit[];
  url: string;
  close: () => Promise<void>;
};

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function listen(onRequest: (hit: Hit, res: ServerResponse) => void): Promise<Mock> {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const hit: Hit = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      hits.push(hit);
      onRequest(hit, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP port");
  return {
    hits,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function client(url: string): ProxmoxClient {
  return new ProxmoxClient({
    host: url,
    tokenId: "cursor@pve!cursor",
    tokenSecret: "test-secret",
    tlsVerify: true,
    defaultNode: "pve",
    fetchImpl: (input, init) => fetch(input, init),
  });
}

function taskOk(hit: Hit, res: ServerResponse): boolean {
  if (hit.method === "GET" && hit.url.includes("/tasks/")) {
    send(res, 200, { data: { status: "stopped", exitstatus: "OK" } });
    return true;
  }
  return false;
}

describe("Proxmox VE 9.2 client", () => {
  test("sends the API token header and lists QEMU guests", async () => {
    const mock = await listen((hit, res) => {
      assert.equal(hit.method, "GET");
      assert.equal(hit.url, "/api2/json/nodes/pve/qemu");
      send(res, 200, {
        data: [{ vmid: 100, name: "web", status: "running" }],
      });
    });
    try {
      const listed = await client(mock.url).listQemu();
      assert.deepEqual(listed, {
        node: "pve",
        guests: [{ vmid: 100, name: "web", status: "running" }],
      });
      assert.equal(mock.hits.length, 1);
      assert.equal(mock.hits[0]?.headers.authorization, "PVEAPIToken=cursor@pve!cursor=test-secret");
      assert.equal(mock.hits[0]?.url.includes("test-secret"), false);
    } finally {
      await mock.close();
    }
  });

  test("refuses delete and force-stop without confirm and does not call the API", async () => {
    const mock = await listen((_hit, res) => {
      send(res, 500, { message: "should not be called" });
    });
    try {
      const api = client(mock.url);
      await assert.rejects(() => api.deleteQemu(100), /Pass confirm: true/);
      await assert.rejects(() => api.deleteQemu(100, undefined, false), /Pass confirm: true/);
      await assert.rejects(() => api.stopQemu(100), /Pass confirm: true/);
      await assert.rejects(() => api.stopLxc(200), /Pass confirm: true/);
      assert.equal(mock.hits.length, 0);
    } finally {
      await mock.close();
    }
  });

  test("confirmed delete sends purge and destroy-unreferenced-disks", async () => {
    const mock = await listen((hit, res) => {
      if (taskOk(hit, res)) return;
      assert.equal(hit.method, "DELETE");
      const url = new URL(hit.url, "http://127.0.0.1");
      assert.equal(url.pathname, "/api2/json/nodes/pve/qemu/100");
      assert.equal(url.searchParams.get("purge"), "1");
      assert.equal(url.searchParams.get("destroy-unreferenced-disks"), "1");
      assert.equal(hit.headers.authorization, "PVEAPIToken=cursor@pve!cursor=test-secret");
      send(res, 200, { data: "UPID:pve:001" });
    });
    try {
      const result = await client(mock.url).deleteQemu(100, undefined, true);
      assert.equal((result as { vmid: number }).vmid, 100);
      assert.equal(mock.hits[0]?.method, "DELETE");
    } finally {
      await mock.close();
    }
  });

  test("returns a clear error when SDN is not configured", async () => {
    const mock = await listen((hit, res) => {
      assert.equal(hit.url, "/api2/json/cluster/sdn/zones");
      send(res, 501, {
        data: null,
        message: "Method 'GET /cluster/sdn/zones' not implemented",
      });
    });
    try {
      await assert.rejects(
        () => client(mock.url).listSdn(),
        /SDN is not configured on this Proxmox VE 9\.2 node/,
      );
      assert.equal(mock.hits.length, 1);
    } finally {
      await mock.close();
    }
  });

  test("does not rewrite an SDN permission error as not configured", async () => {
    const mock = await listen((_hit, res) => {
      send(res, 403, { message: "Permission check failed (/sdn, SDN.Audit)" });
    });
    try {
      await assert.rejects(
        () => client(mock.url).listSdn(),
        /Proxmox API 403: Permission check failed/,
      );
    } finally {
      await mock.close();
    }
  });

  test("creates a cloud-init QEMU guest with the 9.2 config fields", async () => {
    const mock = await listen((hit, res) => {
      if (taskOk(hit, res)) return;
      const params = new URLSearchParams(hit.body);
      assert.equal(hit.method, "POST");
      assert.equal(hit.url, "/api2/json/nodes/pve/qemu");
      assert.equal(params.get("vmid"), "100");
      assert.equal(params.get("name"), "app");
      assert.equal(params.get("cores"), "2");
      assert.equal(params.get("memory"), "2048");
      assert.equal(params.get("scsi0"), "local-lvm:16");
      assert.equal(params.get("ide2"), "local-lvm:cloudinit");
      assert.equal(params.get("net0"), "virtio,bridge=vmbr0");
      assert.equal(params.get("boot"), "order=scsi0");
      assert.equal(params.get("agent"), "enabled=1");
      assert.equal(params.get("scsihw"), "virtio-scsi-pci");
      assert.equal(hit.headers.authorization, "PVEAPIToken=cursor@pve!cursor=test-secret");
      send(res, 200, { data: "UPID:pve:001" });
    });
    try {
      const created = await client(mock.url).createQemu({ name: "app", vmid: 100 });
      assert.equal(created.source, "create");
      assert.equal(created.vmid, 100);
      assert.equal(created.warnings.length, 0);
    } finally {
      await mock.close();
    }
  });
});

describe("config", () => {
  test("keeps TLS verification on unless it is explicitly disabled", () => {
    const base = {
      PROXMOX_HOST: "https://pve.example.ts.net:8006",
      PROXMOX_TOKEN_ID: "cursor@pve!cursor",
      PROXMOX_TOKEN_SECRET: "secret",
    };
    assert.equal(loadConfig(base).tlsVerify, true);
    assert.equal(loadConfig({ ...base, PROXMOX_TLS_VERIFY: "true" }).tlsVerify, true);
    assert.equal(loadConfig({ ...base, PROXMOX_TLS_VERIFY: "false" }).tlsVerify, false);
  });
});

describe("Docker Engine client", () => {
  let mock: Mock;

  before(async () => {
    mock = await listen((hit, res) => {
      assert.equal(hit.url, "/containers/json?all=1");
      send(res, 200, [
        { Id: "abc", Names: ["/web"], Image: "nginx:alpine", State: "running", Status: "Up", Ports: [] },
      ]);
    });
  });

  after(async () => {
    await mock.close();
  });

  test("lists containers from the Engine API", async () => {
    const docker = new DockerClient(`tcp://127.0.0.1:${new URL(mock.url).port}`);
    const rows = await docker.list();
    assert.equal(rows[0]?.id, "abc");
    assert.deepEqual(rows[0]?.names, ["/web"]);
    assert.equal(mock.hits[0]?.url.startsWith("/containers/json"), true);
  });

  test("returns a setup error when DOCKER_HOST is unset", async () => {
    const docker = new DockerClient(undefined);
    await assert.rejects(() => docker.list(), /DOCKER_HOST is not set/);
    await assert.rejects(() => docker.list(), /no Docker API/);
  });

  test("rejects a unix socket host", async () => {
    const docker = new DockerClient("unix:///var/run/docker.sock");
    await assert.rejects(() => docker.list(), /unix sockets are not supported/);
  });
});
