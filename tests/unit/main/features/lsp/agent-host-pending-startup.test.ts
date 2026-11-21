import { expect, mock, test } from "bun:test";
import { startAgentLspHost } from "../../../../../src/main/features/lsp/agent-host";
import type { AgentChannel } from "../../../../../src/main/infra/agent/channel";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function setup() {
  const lookupStarted = Promise.withResolvers<void>();
  const lookup = Promise.withResolvers<{ path: string }>();
  const spawnSent = Promise.withResolvers<void>();
  const spawn = Promise.withResolvers<{ serverId: string }>();
  const sendSpawn = mock(() => spawnSent.resolve());
  const shutdown = mock(async (_serverId: unknown) => {});
  const channel: AgentChannel = {
    ready: Promise.resolve(),
    on: () => () => {},
    onLifecycle: () => () => {},
    dispose() {},
    fire() {},
    async call<T>(method: string, params?: unknown): Promise<T> {
      if (method === "lsp.findBinary") {
        lookupStarted.resolve();
        return (await lookup.promise) as T;
      }
      if (method === "lsp.spawn") {
        sendSpawn();
        return (await spawn.promise) as T;
      }
      if (method === "lsp.shutdown") await shutdown(params);
      return {} as T;
    },
  };
  let enabled = true;
  const host = startAgentLspHost(
    { getAgentChannel: async () => channel },
    { isLanguageEnabled: () => enabled },
  );
  const opening = host.call("didOpen", {
    workspaceId,
    workspaceRoot: "/project",
    uri: "file:///project/main.rs",
    languageId: "rust",
    version: 1,
    text: "fn main() {}",
  });
  return {
    host,
    opening,
    lookupStarted: lookupStarted.promise,
    finishLookup: () => lookup.resolve({ path: "/unused/rust-analyzer" }),
    spawnSent: spawnSent.promise,
    sendSpawn,
    finishSpawn: () => spawn.resolve({ serverId: "late-server" }),
    shutdown,
    turnOff() {
      enabled = false;
      host.disposeLanguage(workspaceId, "rust", "off");
    },
  };
}

test("turning off an LSP invalidates a pending binary lookup", async () => {
  const pending = setup();
  await pending.lookupStarted;
  pending.turnOff();
  pending.finishLookup();
  await pending.opening;
  expect(pending.host.serverStatuses()).toMatchObject([{ state: "stopped", stopReason: "off" }]);
  expect(pending.sendSpawn).not.toHaveBeenCalled();
  await pending.host.dispose();
});

test("turning off an LSP shuts down a child whose spawn was already sent", async () => {
  const pending = setup();
  pending.finishLookup();
  await pending.spawnSent;
  pending.turnOff();
  pending.finishSpawn();
  await pending.opening;
  expect(pending.shutdown).toHaveBeenCalledWith({ serverId: "late-server" });
  expect(pending.host.serverStatuses()).toMatchObject([{ state: "stopped", stopReason: "off" }]);
  await pending.host.dispose();
});

test("host disposal does not wait for an in-flight binary lookup", async () => {
  const pending = setup();
  await pending.lookupStarted;
  await pending.host.dispose();
  pending.finishLookup();
  await pending.opening;
  expect(pending.sendSpawn).not.toHaveBeenCalled();
});

test("host disposal waits for a sent spawn and stops the late child", async () => {
  const pending = setup();
  pending.finishLookup();
  await pending.spawnSent;
  const finished = mock(() => {});
  const disposing = pending.host.dispose().then(finished);
  await new Promise((resolve) => setImmediate(resolve));
  expect(finished).not.toHaveBeenCalled();

  pending.finishSpawn();
  await Promise.all([disposing, pending.opening]);
  expect(pending.shutdown).toHaveBeenCalledTimes(1);
  expect(pending.shutdown).toHaveBeenCalledWith({ serverId: "late-server" });
});
