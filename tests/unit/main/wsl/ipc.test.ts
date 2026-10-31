import { afterEach, describe, expect, mock, test } from "bun:test";
import { SshBrowseSessionRegistry } from "../../../../src/main/features/ssh/browse-session-registry";
import { openWslBrowseSessionHandler } from "../../../../src/main/features/wsl/ipc";
import { createSshError } from "../../../../src/main/infra/agent/pipe";

const registries: SshBrowseSessionRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});

function makeRegistry(): SshBrowseSessionRegistry {
  const registry = new SshBrowseSessionRegistry();
  registries.push(registry);
  return registry;
}

function makeChannel(ready: Promise<void> = Promise.resolve()) {
  return { ready, dispose: mock(() => {}), call: mock(async () => []) };
}

const bootstrapResult = {
  remoteCommand: "bash -lc 'agent --dial sock'",
  remoteHome: "/home/me",
  platform: { os: "linux" as const, arch: "amd64" as const },
  uploaded: true,
  remoteBinDir: "/home/me/.nexus-code/bin",
};

describe("wsl.openBrowseSession", () => {
  test("starts an agent rooted at / and opens the picker at the user's home", async () => {
    const registry = makeRegistry();
    const channel = makeChannel();
    const bootstrap = mock(
      async (_options: unknown, deps?: { onProgress?: (e: never) => void }) => {
        deps?.onProgress?.({ name: "agent-linux-amd64", phase: "uploading" } as never);
        return bootstrapResult;
      },
    );
    const createChannel = mock(() => channel);
    const broadcast = mock((_channel: string, _event: string, _args: unknown) => {});
    const open = openWslBrowseSessionHandler(registry, broadcast, {
      bootstrap: bootstrap as never,
      createChannel: createChannel as never,
    });

    const { sessionId, initialPath } = await open({ distro: "Ubuntu", progressId: "p1" });

    expect(bootstrap.mock.calls[0][0]).toEqual({ distro: "Ubuntu", remotePath: "/" });
    expect(createChannel).toHaveBeenCalledWith({
      distro: "Ubuntu",
      remoteCommand: bootstrapResult.remoteCommand,
    });
    expect(initialPath).toBe("/home/me");
    expect(registry.get(sessionId)?.channel).toBe(channel as never);
    expect(broadcast).toHaveBeenCalledWith("ssh", "browseProgress", {
      progressId: "p1",
      name: "agent-linux-amd64",
      phase: "uploading",
      bytesDone: undefined,
      bytesTotal: undefined,
    });
  });

  test("fails with what wsl.exe said, and leaves no session behind", async () => {
    const registry = makeRegistry();
    const open = openWslBrowseSessionHandler(registry, undefined, {
      bootstrap: (async () => {
        throw createSshError(
          "transport.unknown",
          new Error("There is no distribution with the supplied name."),
        );
      }) as never,
    });

    await expect(open({ distro: "Nope" })).rejects.toThrow(
      "There is no distribution with the supplied name.",
    );
  });

  test("closes the channel when the agent never answers", async () => {
    const registry = makeRegistry();
    const channel = makeChannel(Promise.reject(new Error("agent exited")));
    channel.ready.catch(() => {});
    const open = openWslBrowseSessionHandler(registry, undefined, {
      bootstrap: (async () => bootstrapResult) as never,
      createChannel: (() => channel) as never,
    });

    await expect(open({ distro: "Ubuntu" })).rejects.toThrow("agent exited");
    expect(channel.dispose).toHaveBeenCalledTimes(1);
  });
});
