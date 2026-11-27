import { describe, expect, it } from "bun:test";
import { ipcErr, ipcOk } from "../../../../../src/shared/ipc/result";

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

import * as browserOperations from "../../../../../src/renderer/state/operations/browser";
import { useBrowserRuntimeStore } from "../../../../../src/renderer/state/stores/browser-runtime";
import { type BrowserTabProps, useTabsStore } from "../../../../../src/renderer/state/stores/tabs";

describe("resolveInitialBrowserUrl", () => {
  function makeProps(lastUrl: string, initialUrl = "https://initial.example.com"): BrowserTabProps {
    return { initialUrl, lastUrl, partition: "persist:browser-ws" };
  }

  it("returns null for a javascript: scheme", () => {
    const result = browserOperations.resolveInitialBrowserUrl(makeProps("javascript:alert(1)"));
    expect(result).toBeNull();
  });

  it("does not fall back to initialUrl when lastUrl fails validation", () => {
    const result = browserOperations.resolveInitialBrowserUrl(
      makeProps("javascript:void(0)", "https://fallback.example.com"),
    );
    expect(result).toBeNull();
  });
});

describe("browser view creation", () => {
  const args = {
    tabId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    url: "https://example.com",
    partition: "persist:test",
  };

  it.each([
    "error result",
    "rejected transport",
  ])("reports %s and can create a fresh view", async (failure) => {
    const originalWindow = globalThis.window;
    const calls: Array<{ method: string; viewId: string }> = [];
    Object.assign(globalThis, {
      window: {
        ipc: {
          call: async (_channel: string, method: string, { viewId }: { viewId: string }) => {
            calls.push({ method, viewId });
            if (calls.length !== 1) return ipcOk(undefined);
            if (failure === "rejected transport") throw new Error("transport failed");
            return ipcErr("browser-create-failed", "setup failed");
          },
        },
      },
    });
    const first = Promise.withResolvers<string | null>();
    const second = Promise.withResolvers<string | null>();
    try {
      const closeFirst = browserOperations.mountBrowserView(args, first.resolve);
      expect(await first.promise).toBeNull();
      closeFirst();
      const closeSecond = browserOperations.mountBrowserView(args, second.resolve);
      const viewId = await second.promise;
      expect(viewId).toBeString();
      expect(viewId).not.toBe(calls[0]?.viewId);
      expect(calls).toEqual([
        { method: "create", viewId: expect.any(String) },
        { method: "destroy", viewId: calls[0]?.viewId },
        { method: "create", viewId },
      ]);
      closeSecond();
    } finally {
      Object.assign(globalThis, { window: originalWindow });
    }
  });

  it("ignores a create result after its view was replaced", async () => {
    const originalWindow = globalThis.window;
    const pending = Promise.withResolvers<ReturnType<typeof ipcOk>>();
    const created: Array<string | null> = [];
    let calls = 0;
    Object.assign(globalThis, {
      window: { ipc: { call: async () => (++calls === 1 ? pending.promise : ipcOk(undefined)) } },
    });
    try {
      const closeFirst = browserOperations.mountBrowserView(args, (id) => created.push(id));
      closeFirst();
      const second = Promise.withResolvers<string | null>();
      const closeSecond = browserOperations.mountBrowserView(args, second.resolve);
      expect(await second.promise).toBeString();
      pending.resolve(ipcOk(undefined));
      await Bun.sleep(0);
      expect(created).toEqual([]);
      closeSecond();
    } finally {
      Object.assign(globalThis, { window: originalWindow });
    }
  });
});

it("ignores events from a closed browser generation and accepts the reopened view's events", () => {
  const workspaceId = crypto.randomUUID();
  const tab = useTabsStore.getState().createTab(workspaceId, {
    type: "browser",
    props: { initialUrl: "", lastUrl: "", partition: "persist:test" },
  });
  const originalWindow = globalThis.window;
  const listeners = new Map<string, (payload: unknown) => void>();
  Object.assign(globalThis, {
    window: {
      ipc: {
        listen: (_channel: string, event: string, callback: (payload: unknown) => void) => {
          listeners.set(event, callback);
          return () => listeners.delete(event);
        },
      },
    },
  });
  const nav = (viewId: string, url: string) =>
    listeners.get("navigated")?.({
      tabId: tab.id,
      viewId,
      url,
      canGoBack: false,
      canGoForward: false,
    });
  const current = () => useBrowserRuntimeStore.getState().runtimes.get(tab.id);
  try {
    browserOperations.initBrowserRuntimeSubscriptions();
    const first = browserOperations.beginBrowserView(workspaceId, tab.id);
    nav(first, "https://old.example");
    expect(current()?.currentUrl).toBe("https://old.example");
    browserOperations.endBrowserView(tab.id, first);

    listeners.get("snapshot")?.({
      kind: "set",
      tabId: tab.id,
      viewId: first,
      dataUrl: "old snapshot",
    });
    expect(current()).toBeUndefined();

    const second = browserOperations.beginBrowserView(workspaceId, tab.id);
    nav(second, "https://new.example");
    nav(first, "https://stale.example");
    expect(current()?.currentUrl).toBe("https://new.example");
    expect(useTabsStore.getState().byWorkspace[workspaceId]?.[tab.id]).toMatchObject({
      props: { lastUrl: "https://new.example" },
    });
    browserOperations.endBrowserView(tab.id, second);
  } finally {
    useBrowserRuntimeStore.getState().removeRuntime(tab.id);
    useTabsStore.getState().closeAllForWorkspace(workspaceId);
    Object.assign(globalThis, { window: originalWindow });
  }
});
