/**
 * External-change reconcile must never hide a buffer with unsaved edits.
 *
 * A `git checkout other && git checkout -` round trip deletes and recreates
 * the file under an open, edited buffer. The failed read used to move the
 * entry to the error phase (snapshot hides the model) and the later
 * successful read took the dirty branch without restoring it, so the edits
 * were unreachable: the editor showed the error state and save found no
 * model.
 */

import { describe, expect, mock, test } from "bun:test";
import type { ModelEntryDeps } from "../../../../../src/renderer/services/editor/model/entry";

const { createEntry, snapshot } = await import(
  "../../../../../src/renderer/services/editor/model/entry.ts?reconcile-dirty"
);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

type Disk = { content: string; isBinary?: boolean } | null;

function makeHarness(initial: string) {
  let value = initial;
  const model = {
    getValue: () => value,
    setValue: (next: string) => {
      value = next;
    },
    getAlternativeVersionId: () => 1,
    getLanguageId: () => "plaintext",
    onDidChangeContent: () => ({ dispose: () => {} }),
    isDisposed: () => false,
    dispose: () => {},
  };
  let disk: Disk = { content: initial };
  let fsChanged: (() => void) | null = null;
  const deps = {
    attachDirtyTracker: mock(() => undefined as never),
    detachDirtyTracker: mock(() => {}),
    markDirtyTrackerSaved: mock(() => {}),
    readFileForModel: mock(async () => {
      if (!disk) throw new Error("NOT_FOUND: /workspace/a.ts");
      return {
        content: disk.isBinary ? "" : disk.content,
        encoding: "utf8" as const,
        isBinary: disk.isBinary ?? false,
        mtime: "T",
        sizeBytes: disk.content.length,
      };
    }),
    statFileForModel: mock(() => Promise.resolve({ mtime: "T", size: 0 })),
    getDirtyEntry: mock(() => undefined),
    subscribeFsChanged: mock((_input: unknown, onChanged: () => void) => {
      fsChanged = onChanged;
      return () => {};
    }),
    subscribeGitStatusChanged: mock(() => () => {}),
    attachGitSubscription: mock(() => () => {}),
    workspaceRootForInput: mock(() => "/workspace"),
    isLspLanguage: mock(() => false),
    isLspEnabledForWorkspace: mock(() => false),
    ensureProvidersFor: mock(() => {}),
    monacoContentChangesToLsp: mock(() => []),
    notifyDidChange: mock(() => Promise.resolve()),
    notifyDidClose: mock(() => Promise.resolve()),
    notifyDidOpen: mock(() => Promise.resolve()),
    registerKnownModelUri: mock(() => {}),
    unregisterKnownModelUri: mock(() => {}),
    requireMonaco: mock(() => ({
      Uri: { parse: (raw: string) => ({ toString: () => raw }) },
      editor: { getModel: () => null, createModel: () => model },
    })),
    absolutePathToFileUri: (path: string) => `file://${path}`,
  } as unknown as ModelEntryDeps;

  return {
    deps,
    edit: (next: string) => {
      value = next;
    },
    setDisk: (next: Disk) => {
      disk = next;
    },
    fireFsChanged: async () => {
      if (!fsChanged) throw new Error("fs subscription not attached");
      fsChanged();
      await flush();
    },
  };
}

const input = { workspaceId: "ws-1", filePath: "/workspace/a.ts" };

describe("reconcileExternalChange with unsaved edits", () => {
  test("keeps the buffer visible through a delete and recreate", async () => {
    const h = makeHarness("original");
    const entry = createEntry(input, "file:///workspace/a.ts", h.deps);
    await entry.loadPromise;
    h.edit("edited by user");

    h.setDisk(null);
    await h.fireFsChanged();
    expect(snapshot(entry).phase).toBe("ready");
    expect(snapshot(entry).model?.getValue()).toBe("edited by user");

    h.setDisk({ content: "original" });
    await h.fireFsChanged();
    expect(snapshot(entry).phase).toBe("ready");
    expect(snapshot(entry).model?.getValue()).toBe("edited by user");
  });

  test("does not switch to the binary phase over unsaved edits", async () => {
    const h = makeHarness("original");
    const entry = createEntry(input, "file:///workspace/a.ts", h.deps);
    await entry.loadPromise;
    h.edit("edited by user");

    h.setDisk({ content: "\0\0", isBinary: true });
    await h.fireFsChanged();
    expect(snapshot(entry).phase).toBe("ready");
    expect(snapshot(entry).model?.getValue()).toBe("edited by user");
  });

  test("a clean buffer still reports the missing file", async () => {
    const h = makeHarness("original");
    const entry = createEntry(input, "file:///workspace/a.ts", h.deps);
    await entry.loadPromise;

    h.setDisk(null);
    await h.fireFsChanged();
    expect(snapshot(entry).phase).toBe("error");
  });
});
