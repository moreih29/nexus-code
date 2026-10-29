/**
 * known_hosts checks for the ssh2 client, read as OpenSSH reads the file.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addHostKey,
  checkHostKey,
  hostKeyFingerprint,
  hostKeyType,
  knownHostName,
  matchesHost,
} from "../../../../src/main/infra/agent/ssh/ssh2/known-hosts";

/** A wire-format public key: its type, then stand-in key bytes. */
function wireKey(type: string, fill: number): Buffer {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(name.length);
  return Buffer.concat([length, name, Buffer.alloc(32, fill)]);
}

const dirs: string[] = [];
function knownHostsFile(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-known-hosts-"));
  dirs.push(dir);
  const file = path.join(dir, "known_hosts");
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const ED = wireKey("ssh-ed25519", 1);
const OTHER_ED = wireKey("ssh-ed25519", 2);
const RSA = wireKey("ssh-rsa", 3);
const line = (hosts: string, key: Buffer) =>
  `${hosts} ${hostKeyType(key)} ${key.toString("base64")}`;

describe("matchesHost", () => {
  it("matches names, wildcards and negations as OpenSSH does", () => {
    expect(matchesHost("work,10.0.0.5", "work")).toBe(true);
    expect(matchesHost("WORK", "work")).toBe(true);
    expect(matchesHost("*.example", "a.example")).toBe(true);
    expect(matchesHost("*.example,!bad.example", "bad.example")).toBe(false);
    expect(matchesHost("host?", "host1")).toBe(true);
    expect(matchesHost("[work]:2200", "[work]:2200")).toBe(true);
    expect(matchesHost("work", "[work]:2200")).toBe(false);
  });

  it("matches a hashed name", () => {
    const salt = Buffer.alloc(20, 7);
    const hash = createHmac("sha1", salt).update("work").digest("base64");
    const hashed = `|1|${salt.toString("base64")}|${hash}`;
    expect(matchesHost(hashed, "work")).toBe(true);
    expect(matchesHost(hashed, "other")).toBe(false);
  });
});

describe("checkHostKey", () => {
  it("finds a listed key known and another key of its type changed", async () => {
    const file = knownHostsFile(["# comment", line("work", ED)]);
    expect(await checkHostKey([file], "work", ED)).toEqual({ kind: "known" });
    expect(await checkHostKey([file], "work", OTHER_ED)).toEqual({
      kind: "changed",
      file,
      line: 2,
    });
  });

  it("finds a key of another type unknown, as OpenSSH asks for it", async () => {
    const file = knownHostsFile([line("work", RSA)]);
    expect(await checkHostKey([file], "work", ED)).toEqual({ kind: "unknown" });
  });

  it("refuses a revoked key and skips certificate authorities", async () => {
    const file = knownHostsFile([
      `@cert-authority *.example ${hostKeyType(OTHER_ED)} ${OTHER_ED.toString("base64")}`,
      `@revoked * ${hostKeyType(ED)} ${ED.toString("base64")}`,
      line("work", ED),
    ]);
    expect(await checkHostKey([file], "work", ED)).toEqual({ kind: "revoked", file, line: 2 });
    expect(await checkHostKey([file], "a.example", OTHER_ED)).toEqual({ kind: "unknown" });
  });

  it("reads past missing files", async () => {
    const file = knownHostsFile([line("work", ED)]);
    expect(await checkHostKey(["/nonexistent/known_hosts", file], "work", ED)).toEqual({
      kind: "known",
    });
  });
});

describe("addHostKey", () => {
  it("records a key the next check knows, plain or hashed", async () => {
    const file = knownHostsFile(["work ssh-rsa AAAA"]);
    await addHostKey(file, knownHostName("work", 2200), ED, false);
    await addHostKey(file, "other", RSA, true);

    const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    expect(lines[1]).toBe(line("[work]:2200", ED));
    expect(lines[2].startsWith("|1|")).toBe(true);
    expect(await checkHostKey([file], "[work]:2200", ED)).toEqual({ kind: "known" });
    expect(await checkHostKey([file], "other", RSA)).toEqual({ kind: "known" });
  });

  it("creates the file and its directory", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-known-hosts-"));
    dirs.push(dir);
    const file = path.join(dir, ".ssh", "known_hosts");
    await addHostKey(file, "work", ED, false);
    expect(await checkHostKey([file], "work", ED)).toEqual({ kind: "known" });
  });
});

describe("key labels", () => {
  it("names the key type and its SHA256 fingerprint", () => {
    expect(hostKeyType(ED)).toBe("ssh-ed25519");
    expect(hostKeyFingerprint(ED)).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(knownHostName("work", 22)).toBe("work");
  });
});
