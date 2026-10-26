/**
 * LSP rehydrate after an eviction: keystrokes typed while the server
 * restarts must produce one didOpen, and only changes made after its text
 * snapshot may follow as didChange.
 */

import { expect, test } from "bun:test";
import { attachLspBridge } from "../../../../../src/renderer/services/editor/model/attach-lsp-bridge";
import type {
  ModelEntry,
  ModelEntryDeps,
} from "../../../../../src/renderer/services/editor/model/types";

interface Harness {
  entry: ModelEntry;
  sent: string[];
  type: (nextValue: string, change: string) => void;
  resolveOpens: () => Promise<void>;
}

function setup(): Harness {
  let listener: ((e: { changes: unknown[] }) => void) | null = null;
  let value = "abc";
  const model = {
    onDidChangeContent(cb: (e: { changes: unknown[] }) => void) {
      listener = cb;
      return { dispose() {} };
    },
    getValue: () => value,
  };
  const entry = {
    model,
    languageId: "typescript",
    lspUri: "file:///w/a.ts",
    input: { workspaceId: "w", filePath: "/w/a.ts" },
    version: 57,
    lastLoadedValue: "abc",
    lspOpened: false,
    // The workspace was evicted by the host's LRU.
    lspNeedsRehydrate: true,
    didOpenPromise: Promise.resolve(),
    disposed: false,
  } as unknown as ModelEntry;
  const sent: string[] = [];
  const resolvers: Array<() => void> = [];
  const deps = {
    isLspLanguage: () => true,
    // Skip the initial didOpen; this entry was opened before the eviction.
    isLspEnabledForWorkspace: () => false,
    ensureProvidersFor: () => {},
    workspaceRootForInput: () => "/w",
    monacoContentChangesToLsp: (c: unknown[]) => c,
    notifyDidOpen: (
      _uri: string,
      _ws: string,
      _root: string,
      _lang: string,
      version: number,
      text: string,
    ) => {
      sent.push(`didOpen v${version} ${text}`);
      return new Promise<void>((r) => {
        resolvers.push(r);
      });
    },
    notifyDidChange: (_ws: string, _uri: string, version: number, changes: unknown[]) => {
      sent.push(`didChange v${version} ${changes.join("")}`);
      return Promise.resolve();
    },
  } as unknown as ModelEntryDeps;
  attachLspBridge(entry, "/w", deps);

  return {
    entry,
    sent,
    type(nextValue, change) {
      // Monaco fires the event after the model already holds the edit.
      value = nextValue;
      listener?.({ changes: [change] });
    },
    async resolveOpens() {
      for (const r of resolvers.splice(0)) r();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
  };
}

test("keystrokes during a rehydrate send one didOpen and only later changes", async () => {
  const h = setup();
  h.type("abcX", "+X");
  h.type("abcXY", "+Y");
  await h.resolveOpens();

  expect(h.sent).toEqual(["didOpen v1 abcX", "didChange v2 +Y"]);
  expect(h.entry.lspOpened).toBe(true);
});

test("an eviction during a rehydrate keeps the stale open from marking the entry open", async () => {
  const h = setup();
  h.type("abcX", "+X");
  // Same bookkeeping as resetLspStateForWorkspace.
  h.entry.lspOpened = false;
  h.entry.lspNeedsRehydrate = true;
  h.entry.lspRehydrating = false;
  h.entry.lspOpenEpoch = (h.entry.lspOpenEpoch ?? 0) + 1;
  h.entry.didOpenPromise = Promise.resolve();
  await h.resolveOpens();
  expect(h.entry.lspOpened).toBe(false);

  h.type("abcXY", "+Y");
  await h.resolveOpens();
  expect(h.sent).toEqual(["didOpen v1 abcX", "didOpen v1 abcXY"]);
  expect(h.entry.lspOpened).toBe(true);
});
