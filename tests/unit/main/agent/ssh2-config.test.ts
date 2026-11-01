/**
 * The ssh2 client's view of OpenSSH settings, and of the `ssh` command lines
 * it stands in for.
 */
import { describe, expect, it } from "bun:test";
import path from "node:path";
import { buildSshArgs } from "../../../../src/main/infra/agent/ssh/master";
import {
  buildSftpArgs,
  buildSshTransportArgs,
} from "../../../../src/main/infra/agent/ssh/ssh-bootstrap/transport";
import { resolveSshHostConfig } from "../../../../src/main/infra/agent/ssh/ssh2/config";
import { parseJumpHost } from "../../../../src/main/infra/agent/ssh/ssh2/connect";
import {
  parseDestination,
  parseSftpLine,
  parseSshCommandLine,
} from "../../../../src/main/infra/agent/ssh/ssh2/process";

const HOME = path.resolve("/home/alice");

function resolveWith(printed: string | null, platform: NodeJS.Platform = "linux") {
  const calls: string[][] = [];
  const config = resolveSshHostConfig(
    { host: "work", user: "bob", port: 2200, identityFile: "~/.ssh/work_key" },
    {
      printConfig: async (args) => {
        calls.push([...args]);
        return printed;
      },
      homedir: HOME,
      platform,
      env: { ProgramData: "C:\\ProgramData" },
    },
  );
  return { config, calls };
}

describe("resolveSshHostConfig", () => {
  it("asks ssh -G for the host with the workspace's user, port and key", async () => {
    const { calls } = resolveWith("hostname work.example\n");
    await Promise.resolve();
    expect(calls).toEqual([
      ["-G", "-p", "2200", "-l", "bob", "-i", "~/.ssh/work_key", "--", "work"],
    ]);
  });

  it("reads the settings ssh -G prints", async () => {
    const { config } = resolveWith(
      [
        "user bob",
        "hostname work.example",
        "port 2200",
        "identityfile ~/.ssh/work_key",
        "identityfile ~/.ssh/id_ed25519",
        "identitiesonly yes",
        "proxyjump jump@bastion:2222,inner",
        "connecttimeout 7",
        "userknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2",
        "globalknownhostsfile /etc/ssh/ssh_known_hosts",
        "stricthostkeychecking accept-new",
        "hashknownhosts yes",
        "preferredauthentications publickey,password",
        "identityagent none",
        "forwardagent no",
      ].join("\n"),
    );
    expect(await config).toEqual({
      host: "work",
      hostname: "work.example",
      port: 2200,
      user: "bob",
      identityFiles: [path.join(HOME, ".ssh/work_key"), path.join(HOME, ".ssh/id_ed25519")],
      identitiesOnly: true,
      identityAgent: null,
      forwardAgent: null,
      proxyJump: ["jump@bastion:2222", "inner"],
      proxyCommand: null,
      connectTimeoutMs: 7000,
      hostKeyAlias: null,
      knownHostsFiles: [path.join(HOME, ".ssh/known_hosts"), path.join(HOME, ".ssh/known_hosts2")],
      globalKnownHostsFiles: ["/etc/ssh/ssh_known_hosts"],
      strictHostKeyChecking: "accept-new",
      hashKnownHosts: true,
      preferredAuthentications: ["publickey", "password"],
    });
  });

  it("leaves out the authentication methods the config turns off", async () => {
    const { config } = resolveWith(
      "pubkeyauthentication false\nkbdinteractiveauthentication no\npasswordauthentication yes\n",
    );
    expect((await config).preferredAuthentications).toEqual(["password"]);
  });

  it("expands Win32-OpenSSH's __PROGRAMDATA__ and falls back to its agent pipe", async () => {
    const { config } = resolveWith(
      "hostname work.example\nglobalknownhostsfile __PROGRAMDATA__/ssh/ssh_known_hosts\n",
      "win32",
    );
    const resolved = await config;
    expect(resolved.globalKnownHostsFiles).toEqual(["C:\\ProgramData/ssh/ssh_known_hosts"]);
    expect(resolved.identityAgent).toBe("\\\\.\\pipe\\openssh-ssh-agent");
  });

  it("forwards the agent used to log in for ForwardAgent yes", async () => {
    const { config } = resolveWith("hostname work.example\nforwardagent yes\n", "win32");
    expect((await config).forwardAgent).toBe("\\\\.\\pipe\\openssh-ssh-agent");
  });

  it("forwards the agent ForwardAgent names, as a path or a variable", async () => {
    const byPath = await resolveWith("forwardagent ~/.ssh/agent.sock\n").config;
    expect(byPath.forwardAgent).toBe(path.join(HOME, ".ssh/agent.sock"));
    const byVariable = await resolveSshHostConfig(
      { host: "work" },
      {
        printConfig: async () => "forwardagent $WORK_AGENT\n",
        homedir: HOME,
        platform: "linux",
        env: { WORK_AGENT: "/run/work-agent.sock" },
      },
    );
    expect(byVariable.forwardAgent).toBe("/run/work-agent.sock");
  });

  it("uses the host as given with OpenSSH's defaults when there is no ssh -G", async () => {
    const resolved = await resolveWith(null).config;
    expect(resolved.hostname).toBe("work");
    expect(resolved.port).toBe(2200);
    expect(resolved.user).toBe("bob");
    expect(resolved.identityFiles[0]).toBe(path.join(HOME, ".ssh/work_key"));
    expect(resolved.identityFiles).toContain(path.join(HOME, ".ssh/id_ed25519"));
    expect(resolved.strictHostKeyChecking).toBe("ask");
    expect(resolved.forwardAgent).toBeNull();
    expect(resolved.preferredAuthentications).toEqual([
      "publickey",
      "keyboard-interactive",
      "password",
    ]);
  });
});

describe("parseSshCommandLine", () => {
  it("reads the agent channel's command line", () => {
    const args = buildSshArgs({
      host: "work",
      user: "bob",
      port: 2200,
      identityFile: "/keys/id",
      controlPath: "ssh2:1:bob@work",
      remoteCommand: "bash -lc 'agent'",
    });
    expect(parseSshCommandLine(args)).toEqual({
      controlPath: "ssh2:1:bob@work",
      destination: "bob@work",
      port: 2200,
      identityFile: "/keys/id",
      remoteCommand: "bash -lc 'agent'",
      controlCommand: undefined,
    });
  });

  it("reads the bootstrap's command line", () => {
    const args = [
      ...buildSshTransportArgs({ host: "work", remotePath: "/srv", controlPath: "ssh2:2:work" }),
      "--",
      "work",
      "uname -ms",
    ];
    const line = parseSshCommandLine(args);
    expect(line.controlPath).toBe("ssh2:2:work");
    expect(line.destination).toBe("work");
    expect(line.remoteCommand).toBe("uname -ms");
  });

  it("reads the bootstrap's sftp command line and batch", () => {
    const line = parseSshCommandLine(
      buildSftpArgs({
        host: "work",
        user: "bob",
        port: 2200,
        remotePath: "/srv",
        controlPath: "ssh2:4:bob@work",
      }),
    );
    expect(line).toMatchObject({
      controlPath: "ssh2:4:bob@work",
      destination: "bob@work",
      port: 2200,
    });
    expect(parseSftpLine('put "/tmp/My Agent" "~/.nexus/agent.tmp.1"')).toEqual([
      "put",
      "/tmp/My Agent",
      "~/.nexus/agent.tmp.1",
    ]);
    expect(parseSftpLine('chmod 755 "bin/agent"')).toEqual(["chmod", "755", "bin/agent"]);
  });

  it("reads a control command", () => {
    const line = parseSshCommandLine(["-S", "ssh2:3:work", "-O", "exit", "--", "work"]);
    expect(line.controlCommand).toBe("exit");
    expect(line.remoteCommand).toBeUndefined();
  });

  it("splits a destination and a jump host", () => {
    expect(parseDestination("bob@work")).toEqual({ host: "work", user: "bob" });
    expect(parseDestination("work")).toEqual({ host: "work" });
    expect(parseJumpHost("jump@bastion:2222")).toEqual({
      host: "bastion",
      user: "jump",
      port: 2222,
    });
    expect(parseJumpHost("[fe80::1]:22")).toEqual({ host: "fe80::1", user: undefined, port: 22 });
    expect(parseJumpHost("inner")).toEqual({ host: "inner", user: undefined, port: undefined });
  });
});
