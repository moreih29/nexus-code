import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

const globals = globalThis as { window?: unknown; document?: unknown };
const originalWindow = globals.window;
const originalDocument = globals.document;
globals.document ??= { activeElement: null, body: null, hasFocus: () => false };
globals.window = {
  ...(originalWindow as object),
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => () => {},
    off: () => {},
  },
};

afterAll(() => {
  globals.window = originalWindow;
  globals.document = originalDocument;
});

const { actionHandlers } = await import("../../../../../src/renderer/services/cli/actions");
const { useTabsStore } = await import("../../../../../src/renderer/state/stores/tabs");
const { useLayoutStore } = await import("../../../../../src/renderer/state/stores/layout/store");
const { usePreviewDefaultsStore } = await import(
  "../../../../../src/renderer/state/stores/preview-defaults"
);

const WS = "ws-open";
const open = (filePath: string, view?: "source" | "preview") =>
  actionHandlers["editor.open"]({
    workspaceId: WS,
    filePath,
    ...(view ? { view } : {}),
    placement: { background: true },
  });
const viewOf = (tabId: string) => {
  const tab = useTabsStore.getState().byWorkspace[WS]?.[tabId];
  return tab?.type === "editor" ? tab.viewMode : null;
};

beforeEach(() => {
  usePreviewDefaultsStore.getState().hydrate({});
});

afterEach(() => {
  usePreviewDefaultsStore.getState().hydrate({});
  useTabsStore.setState({ byWorkspace: {} });
  useLayoutStore.setState({ byWorkspace: {} });
});

test("shows the view asked for in its tab, the format's default as it was", async () => {
  const { tabId } = await open("/w/README.md", "source");
  expect(viewOf(tabId)).toBe("raw");
  expect((await open("/w/README.md", "preview")).tabId).toBe(tabId);
  expect(viewOf(tabId)).toBe("preview");
  expect(usePreviewDefaultsStore.getState().byFormat).toEqual({});
  await open("/w/README.md");
  expect(viewOf(tabId)).toBe("preview");
});

test("refuses a preview of a file that has none, and opens its source as ever", async () => {
  await expect(open("/w/src/app.ts", "preview")).rejects.toThrow("app.ts has no preview");
  expect(useTabsStore.getState().byWorkspace[WS]).toBeUndefined();
  const { tabId } = await open("/w/src/app.ts", "source");
  expect(viewOf(tabId)).toBeUndefined();
});
