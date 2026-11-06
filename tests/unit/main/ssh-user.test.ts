import { describe, expect, it } from "bun:test";
import os from "node:os";
import { resolveSshUser } from "../../../src/main/features/ssh/ipc";
import {
  resolveSshHostConfig,
  type SshTarget,
} from "../../../src/main/infra/agent/ssh/ssh2/config";

/** `ssh -G` as a stub: records its arguments and prints `output`. */
function printedConfig(output: string): {
  calls: string[][];
  resolve: (target: SshTarget) => ReturnType<typeof resolveSshHostConfig>;
} {
  const calls: string[][] = [];
  return {
    calls,
    resolve: (target) =>
      resolveSshHostConfig(target, {
        env: {},
        printConfig: async (args) => {
          calls.push([...args]);
          return output;
        },
      }),
  };
}

describe("resolveSshUser", () => {
  it("keeps a user the caller typed", async () => {
    const ssh = printedConfig("user qa\n");
    expect(await resolveSshUser({ host: "dev", user: "deploy" }, ssh.resolve)).toBe("deploy");
    expect(ssh.calls).toEqual([]);
  });

  it("takes a host-only target's user from ssh -G, as ssh would log in", async () => {
    // The user may come from an Include file or a `Host *` block, which only
    // OpenSSH's own resolution sees.
    const ssh = printedConfig("host dev\nhostname 10.0.0.5\nuser qa\nport 2230\n");
    expect(await resolveSshUser({ host: "dev", port: 2230 }, ssh.resolve)).toBe("qa");
    expect(ssh.calls).toEqual([["-G", "-p", "2230", "--", "dev"]]);
  });

  it("falls back to the local account when the config cannot be read", async () => {
    const failing = async (): Promise<never> => {
      throw new Error("ssh missing");
    };
    expect(await resolveSshUser({ host: "dev" }, failing)).toBe(os.userInfo().username);
  });
});
