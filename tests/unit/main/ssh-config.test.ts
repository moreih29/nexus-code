import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listConfigHostsHandler } from "../../../src/main/ipc/channels/ssh";
import { parseSshConfig } from "../../../src/main/ssh-config";

describe("parseSshConfig", () => {
  it("returns concrete Host aliases with supported options", () => {
    const hosts = parseSshConfig(`
Host dev prod
  HostName dev.example.com
  User deploy
  Port 2222
  IdentityFile ~/.ssh/deploy_key

Host *
  User ignored

Host build-*
  HostName ignored.example.com
`);

    expect(hosts).toEqual([
      {
        alias: "dev",
        host: "dev.example.com",
        user: "deploy",
        port: 2222,
        identityFile: "~/.ssh/deploy_key",
      },
      {
        alias: "prod",
        host: "dev.example.com",
        user: "deploy",
        port: 2222,
        identityFile: "~/.ssh/deploy_key",
      },
    ]);
  });

  it("ignores Include and resumes parsing at later Host directives", () => {
    const hosts = parseSshConfig(`
Include ~/.ssh/config.d/*

Host one
  HostName one.example.com

Match all
  User ignored

Host two ?ild !negated
  User remote
`);

    expect(hosts).toEqual([
      { alias: "one", host: "one.example.com" },
      { alias: "two", user: "remote" },
    ]);
  });

  it("tolerates mixed-case keywords and irregular indentation", () => {
    const hosts = parseSshConfig(`
    hOsT mixed
\tHoStNaMe = mixed.example.com
USER deploy
        pOrT=2200
  IdentityFile   "~/.ssh/mixed key"

      HoST sibling
HostName sibling.example.com
`);

    expect(hosts).toEqual([
      {
        alias: "mixed",
        host: "mixed.example.com",
        user: "deploy",
        port: 2200,
        identityFile: "~/.ssh/mixed key",
      },
      { alias: "sibling", host: "sibling.example.com" },
    ]);
  });
});

describe("listConfigHostsHandler", () => {
  it("reads ssh config hosts through the IPC contract shape", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ssh-config-"));
    const configPath = path.join(tmpDir, "config");
    fs.writeFileSync(configPath, "Host dev\n  HostName dev.example.com\n");

    try {
      const hosts = await listConfigHostsHandler(configPath)(undefined);

      expect(hosts).toEqual([{ alias: "dev", host: "dev.example.com" }]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns an empty list when the ssh config file is missing", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ssh-config-"));
    const configPath = path.join(tmpDir, "missing-config");

    try {
      const hosts = await listConfigHostsHandler(configPath)(undefined);

      expect(hosts).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
