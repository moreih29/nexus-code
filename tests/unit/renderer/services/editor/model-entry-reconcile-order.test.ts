/**
 * External-change reconcile must apply the newest read: a formatter or a
 * checkout fires several fs.changed events, and a slow early read that
 * resolves last must not install older disk content and mark it clean.
 */

import { expect, mock, test } from "bun:test";
import type { ModelEntryDeps } from "../../../../../src/renderer/services/editor/model/entry";

const { createEntry, reconcileExternalChange } = await import(
  "../../../../../src/renderer/services/editor/model/entry.ts?reconcile-order"
);

interface PendingRead {
  resolve: (content: string) => void;
}

test("a slow earlier read does not overwrite a newer one", async () => {
  let value = "v0";
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
  const reads: PendingRead[] = [];
  let initialLoad = true;
  const deps = {
    attachDirtyTracker: mock(() => undefined as never),
    detachDirtyTracker: mock(() => {}),
    markDirtyTrackerSaved: mock(() => {}),
    readFileForModel: mock(() => {
      const file = (content: string) => ({
        content,
        encoding: "utf8" as const,
        isBinary: false,
        mtime: "T",
        sizeBytes: content.length,
      });
      if (initialLoad) {
        initialLoad = false;
        return Promise.resolve(file("v0"));
      }
      return new Promise((resolve) => {
        reads.push({ resolve: (content) => resolve(file(content)) });
      });
    }),
    statFileForModel: mock(() => Promise.resolve({ mtime: "T", size: 0 })),
    getDirtyEntry: mock(() => undefined),
    subscribeFsChanged: mock(() => () => {}),
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

  const entry = createEntry(
    { workspaceId: "ws-1", filePath: "/workspace/a.ts" },
    "file:///workspace/a.ts",
    deps,
  );
  await entry.loadPromise;

  const first = reconcileExternalChange(entry);
  const second = reconcileExternalChange(entry);
  reads[1]?.resolve("v2");
  await second;
  reads[0]?.resolve("v1");
  await first;

  expect(value).toBe("v2");
  expect(entry.lastLoadedValue).toBe("v2");
});
