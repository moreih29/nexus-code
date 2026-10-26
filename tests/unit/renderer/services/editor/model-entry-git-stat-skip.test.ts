/**
 * git.statusChanged-triggered reconcile — stat gate.
 *
 * git.statusChanged is workspace-wide, so the entry stats its file first and
 * only performs the full read + reconcile when mtime/size moved away from the
 * dirty tracker's loaded baseline. A failing stat must fall back to the full
 * reconcile rather than silently skipping it.
 */

import { describe, expect, mock, test } from "bun:test";
import type { ModelEntryDeps } from "../../../../../src/renderer/services/editor/model/entry";

const { createEntry } = await import(
  "../../../../../src/renderer/services/editor/model/entry.ts?git-stat-skip"
);

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeFakeModel() {
  return {
    getValue: () => "initial",
    setValue: () => {},
    getAlternativeVersionId: () => 1,
    getLanguageId: () => "plaintext",
    onDidChangeContent: () => ({ dispose: () => {} }),
    isDisposed: () => false,
    dispose: () => {},
  };
}

function makeHarness(stat: () => Promise<{ mtime: string; size: number }>) {
  const model = makeFakeModel();
  let gitCallback: (() => void) | null = null;
  const readFileForModel = mock(() =>
    Promise.resolve({
      content: "initial",
      encoding: "utf8" as const,
      isBinary: false,
      mtime: "T1",
      sizeBytes: 7,
    }),
  );
  const statFileForModel = mock(stat);
  const deps = {
    attachDirtyTracker: mock(() => undefined as never),
    detachDirtyTracker: mock(() => {}),
    markDirtyTrackerSaved: mock(() => {}),
    readFileForModel,
    statFileForModel,
    getDirtyEntry: mock(() => ({ loadedMtime: "T1", loadedSize: 7 }) as never),
    subscribeFsChanged: mock(() => () => {}),
    subscribeGitStatusChanged: mock(() => () => {}),
    attachGitSubscription: mock((_entry: unknown, _deps: unknown, onChanged: () => void) => {
      gitCallback = onChanged;
      return () => {};
    }),
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

  const fireGit = async () => {
    if (!gitCallback) throw new Error("git subscription not attached");
    gitCallback();
    await flushAsyncWork();
  };
  return { deps, readFileForModel, statFileForModel, fireGit };
}

const input = { workspaceId: "ws-1", filePath: "/workspace/page.html" };

describe("git-triggered reconcile stat gate", () => {
  test("skips the full read when mtime and size match the loaded baseline", async () => {
    const h = makeHarness(() => Promise.resolve({ mtime: "T1", size: 7 }));
    const entry = createEntry(input, "file:///workspace/page.html", h.deps);
    await entry.loadPromise;
    expect(h.readFileForModel).toHaveBeenCalledTimes(1);

    await h.fireGit();

    expect(h.statFileForModel).toHaveBeenCalledTimes(1);
    expect(h.readFileForModel).toHaveBeenCalledTimes(1);
  });

  test("reconciles when the file's mtime moved", async () => {
    const h = makeHarness(() => Promise.resolve({ mtime: "T2", size: 7 }));
    const entry = createEntry(input, "file:///workspace/page.html", h.deps);
    await entry.loadPromise;

    await h.fireGit();

    expect(h.readFileForModel).toHaveBeenCalledTimes(2);
  });

  test("reconciles when the file's size moved", async () => {
    const h = makeHarness(() => Promise.resolve({ mtime: "T1", size: 8 }));
    const entry = createEntry(input, "file:///workspace/page.html", h.deps);
    await entry.loadPromise;

    await h.fireGit();

    expect(h.readFileForModel).toHaveBeenCalledTimes(2);
  });

  test("falls back to the full reconcile when stat fails", async () => {
    const h = makeHarness(() => Promise.reject(new Error("NOT_FOUND: /workspace/page.html")));
    const entry = createEntry(input, "file:///workspace/page.html", h.deps);
    await entry.loadPromise;

    await h.fireGit();

    expect(h.readFileForModel).toHaveBeenCalledTimes(2);
  });
});
