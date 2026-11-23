import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type HostKeyStatus =
  | { readonly kind: "known" }
  | { readonly kind: "unknown" }
  | { readonly kind: "changed"; readonly file: string; readonly line: number }
  | { readonly kind: "revoked"; readonly file: string; readonly line: number };

export function knownHostName(hostname: string, port: number): string {
  return port === 22 ? hostname : `[${hostname}]:${port}`;
}

export function hostKeyType(key: Buffer): string {
  if (key.length < 4) return "unknown";
  const length = key.readUInt32BE(0);
  return key.subarray(4, 4 + length).toString("ascii");
}

export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

export async function checkHostKey(
  files: readonly string[],
  name: string,
  key: Buffer,
): Promise<HostKeyStatus> {
  const type = hostKeyType(key);
  let status: HostKeyStatus = { kind: "unknown" };
  for (const file of files) {
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const entry = parseEntry(lines[index]);
      if (!entry || entry.marker === "@cert-authority") continue;
      if (!matchesHost(entry.hosts, name)) continue;
      const sameKey = entry.type === type && entry.key.equals(key);
      if (entry.marker === "@revoked") {
        if (sameKey) return { kind: "revoked", file, line: index + 1 };
        continue;
      }
      if (sameKey) {
        status = { kind: "known" };
      } else if (entry.type === type && status.kind === "unknown") {
        status = { kind: "changed", file, line: index + 1 };
      }
    }
  }
  return status;
}

export async function addHostKey(
  file: string,
  name: string,
  key: Buffer,
  hash: boolean,
): Promise<void> {
  const listed = hash ? hashHostName(name, randomBytes(20)) : name;
  const line = `${listed} ${hostKeyType(key)} ${key.toString("base64")}\n`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let prefix = "";
  try {
    const existing = await fs.readFile(file, "utf8");
    if (existing.length > 0 && !existing.endsWith("\n")) prefix = "\n";
  } catch {}
  await fs.appendFile(file, prefix + line, { mode: 0o600 });
}

interface KnownHostEntry {
  readonly marker: "@revoked" | "@cert-authority" | null;
  readonly hosts: string;
  readonly type: string;
  readonly key: Buffer;
}

function parseEntry(line: string): KnownHostEntry | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return null;
  const fields = trimmed.split(/\s+/);
  let marker: KnownHostEntry["marker"] = null;
  if (fields[0] === "@revoked" || fields[0] === "@cert-authority") {
    marker = fields[0];
    fields.shift();
  } else if (fields[0]?.startsWith("@")) {
    return null;
  }
  if (fields.length < 3) return null;
  return { marker, hosts: fields[0], type: fields[1], key: Buffer.from(fields[2], "base64") };
}

export function matchesHost(hosts: string, name: string): boolean {
  if (hosts.startsWith("|1|")) {
    const [, , salt, hash] = hosts.split("|");
    if (!salt || !hash) return false;
    return hashHostName(name, Buffer.from(salt, "base64")) === hosts;
  }
  let matched = false;
  for (const pattern of hosts.split(",")) {
    const negated = pattern.startsWith("!");
    const glob = negated ? pattern.slice(1) : pattern;
    if (!globMatches(glob.toLowerCase(), name.toLowerCase())) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

function hashHostName(name: string, salt: Buffer): string {
  const hash = createHmac("sha1", salt).update(name).digest("base64");
  return `|1|${salt.toString("base64")}|${hash}`;
}

function globMatches(pattern: string, value: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`).test(value);
}
