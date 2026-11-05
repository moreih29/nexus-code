/**
 * The view each format with a preview opens in: chosen in Settings, saved
 * to appState, a format this version does not know dropped on load, and
 * one left out opening as it does by default.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

const writes: unknown[] = [];

const CLIENT = "../../../../../src/renderer/ipc/client";

// Other files mock the IPC client process-wide, so this file installs its
// own and puts back whatever it found when it is done.
const previousClient = { ...(await import(CLIENT)) };
mock.module(CLIENT, () => ({
  ...previousClient,
  ipcCallResult: (_channel: string, _method: string, args: unknown) => {
    writes.push(args);
    return Promise.resolve({ ok: true, value: undefined });
  },
}));
afterAll(() => {
  mock.module(CLIENT, () => previousClient);
});

const { usePreviewDefaultsStore } = await import(
  "../../../../../src/renderer/state/stores/preview-defaults"
);
const { defaultViewMode } = await import(
  "../../../../../src/renderer/services/editor/preview/previewable"
);

const opens = (path: string) => defaultViewMode(path, usePreviewDefaultsStore.getState().byFormat);

beforeEach(() => {
  usePreviewDefaultsStore.getState().hydrate(undefined);
  writes.length = 0;
});

describe("usePreviewDefaultsStore", () => {
  it("opens each format as it does by default until one is chosen", () => {
    expect(opens("/r/README.md")).toBe("preview");
    expect(opens("/r/package.json")).toBe("raw");
  });

  it("opens a format in the view chosen for it, and saves the choice", () => {
    usePreviewDefaultsStore.getState().setDefault("json", "preview");
    usePreviewDefaultsStore.getState().setDefault("markdown", "raw");
    expect(opens("/r/package.json")).toBe("preview");
    expect(opens("/r/tsconfig.jsonc")).toBe("preview");
    expect(opens("/r/README.md")).toBe("raw");
    expect(opens("/r/ci.yml")).toBe("raw");
    expect(writes.at(-1)).toEqual({ previewViewDefaults: { json: "preview", markdown: "raw" } });
  });

  it("goes back to the default when a choice is reset, or all are", () => {
    usePreviewDefaultsStore.getState().setDefault("yaml", "preview");
    usePreviewDefaultsStore.getState().setDefault("html", "raw");
    usePreviewDefaultsStore.getState().setDefault("yaml", undefined);
    expect(opens("/r/ci.yml")).toBe("raw");
    expect(writes.at(-1)).toEqual({ previewViewDefaults: { html: "raw" } });
    usePreviewDefaultsStore.getState().clear();
    expect(opens("/r/index.html")).toBe("preview");
    expect(writes.at(-1)).toEqual({ previewViewDefaults: {} });
  });

  it("drops a format it does not know on load", () => {
    usePreviewDefaultsStore.getState().hydrate({ json: "preview", future: "raw" });
    expect(usePreviewDefaultsStore.getState().byFormat).toEqual({ json: "preview" });
  });

  it("leaves a file without a preview in its source", () => {
    usePreviewDefaultsStore.getState().setDefault("markdown", "preview");
    expect(opens("/r/index.ts")).toBe("raw");
    expect(opens("/r/page.mdx")).toBe("raw");
  });
});
