/**
 * Host-key checks against OpenSSH's known_hosts files, for the ssh2 client.
 *
 * The ssh2 client reads and writes the same files `ssh` does, so a host
 * trusted through either is trusted by both. Entries are matched as OpenSSH
 * matches them: comma-separated host patterns with `*` and `?` wildcards and
 * `!` negation, hashed `|1|salt|hash` names, and `[host]:port` for a port
 * other than 22. `@revoked` keys are refused; `@cert-authority` lines are
 * skipped, since the client does not check host certificates.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type HostKeyStatus =
  | { readonly kind: "known" }
  | { readonly kind: "unknown" }
  /** The host has a different key of the same type: it may be impersonated. */
  | { readonly kind: "changed"; readonly file: string; readonly line: number }
  | { readonly kind: "revoked"; readonly file: string; readonly line: number };

/** The name a host's keys are listed under: `host`, or `[host]:port` off port 22. */
export function knownHostName(hostname: string, port: number): string {
  return port === 22 ? hostname : `[${hostname}]:${port}`;
}

/** The key type a wire-format public key names, such as `ssh-ed25519`. */
export function hostKeyType(key: Buffer): string {
  if (key.length < 4) return "unknown";
  const length = key.readUInt32BE(0);
  return key.subarray(4, 4 + length).toString("ascii");
}

/** OpenSSH's fingerprint form for a key: `SHA256:` and unpadded base64. */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

/** Checks `key` for the host listed as `name` in each file, in order. */
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

/** Appends `key` for the host listed as `name`, hashing the name when asked. */
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
  } catch {
    // A new file.
  }
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

/** Whether a known_hosts host field lists `name`, as OpenSSH reads it. */
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
