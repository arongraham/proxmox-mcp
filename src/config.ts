export type AppConfig = {
  host: string;
  tokenId: string;
  tokenSecret: string;
  node?: string;
  tlsVerify: boolean;
  dockerHost?: string;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Set ${name}. See .env.example.`);
  }
  return value;
}

function tlsVerifyFrom(raw: string | undefined): boolean {
  const value = raw?.trim() ?? "";
  if (value === "") return true;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new Error("PROXMOX_TLS_VERIFY must be true or false.");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const host = required(env, "PROXMOX_HOST").replace(/\/+$/, "");
  const tokenId = required(env, "PROXMOX_TOKEN_ID");
  const tokenSecret = required(env, "PROXMOX_TOKEN_SECRET");
  if (!tokenId.includes("@") || !tokenId.includes("!")) {
    throw new Error("PROXMOX_TOKEN_ID must look like user@realm!tokenid.");
  }

  let parsed: URL;
  try {
    parsed = new URL(host);
  } catch {
    throw new Error(
      "PROXMOX_HOST must be an https URL on port 8006, for example https://pve.<tailnet>.ts.net:8006.",
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("PROXMOX_HOST must use https. http is only for local tests.");
  }

  const node = env.PROXMOX_NODE?.trim() || undefined;
  const dockerHost = env.DOCKER_HOST?.trim() || undefined;
  return {
    host,
    tokenId,
    tokenSecret,
    node,
    tlsVerify: tlsVerifyFrom(env.PROXMOX_TLS_VERIFY),
    dockerHost,
  };
}
