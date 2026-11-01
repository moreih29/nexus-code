/**
 * WaitRegistry — which terminals are blocked waiting on which, until the
 * wait ends or the waiting terminal exits.
 */
import { expect, test } from "bun:test";
import { WaitRegistry } from "../../../../src/main/features/cli/waits";

function host() {
  const listeners = new Map<string, (args: unknown) => void>();
  return {
    on(event: string, cb: (args: unknown) => void) {
      listeners.set(event, cb);
      return () => listeners.delete(event);
    },
    emit(event: string, args: unknown) {
      listeners.get(event)?.(args);
    },
  };
}

test("a wait is listed until it ends", () => {
  const registry = new WaitRegistry();
  const end = registry.begin({ workspaceId: "w", tabId: "a" }, { workspaceId: "v", tabId: "b" }, 5);
  expect(registry.snapshot()).toEqual([
    {
      waiter: { workspaceId: "w", tabId: "a" },
      target: { workspaceId: "v", tabId: "b" },
      since: 5,
    },
  ]);
  end();
  expect(registry.snapshot()).toEqual([]);
});

test("the waiting terminal's exit ends its waits", () => {
  const source = host();
  const registry = new WaitRegistry(source);
  registry.begin({ workspaceId: "w", tabId: "a" }, { workspaceId: "v", tabId: "b" }, 1);
  registry.begin({ workspaceId: "w", tabId: "c" }, { workspaceId: "v", tabId: "b" }, 2);
  source.emit("exit", { workspaceId: "w", tabId: "a" });
  expect(registry.snapshot().map((w) => w.waiter.tabId)).toEqual(["c"]);
});
