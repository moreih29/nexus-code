/**
 * LSP rehydrate after an eviction: keystrokes typed while the server
 * restarts must produce one didOpen, and only changes made after its text
 * snapshot may follow as didChange. A file that loaded while its language
 * was off is opened once the language is turned on. Once a file is open,
 * each change goes out before its handler returns, and in order.
 */

import { expect, test } from "bun:test";
import {
  attachLspBridge,
  rehydrateEntryLspOpened,
} from "../../../../../src/renderer/services/editor/model/attach-lsp-bridge";
import type {
  ModelEntry,
  ModelEntryDeps,
} from "../../../../../src/renderer/services/editor/model/types";

interface Harness {
  entry: ModelEntry;
  deps: ModelEntryDeps;
  sent: string[];
  type: (nextValue: string, change: string) => void;
  setEnabled: (on: boolean) => void;
  resolveOpens: () => Promise<void>;
}

function setup(opts: { evicted: boolean; enabledAtAttach?: boolean } = { evicted: true }): Harness {
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
    lspNeedsRehydrate: opts.evicted,
    didOpenPromise: opts.evicted ? Promise.resolve() : undefined,
    disposed: false,
  } as unknown as ModelEntry;
  const sent: string[] = [];
  const resolvers: Array<() => void> = [];
  // Off while attaching, unless asked: an evicted entry was opened before
  // the eviction, and the other entry loads with its language off.
  let enabled = opts.enabledAtAttach === true;
  const deps = {
    isLspLanguage: () => true,
    isLspEnabledForWorkspace: (_ws: string, lang: string) => enabled && lang === "typescript",
    ensureProvidersFor: (lang: string) => {
      sent.push(`providers ${lang}`);
    },
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
  if (opts.evicted) enabled = true;

  return {
    entry,
    deps,
    sent,
    type(nextValue, change) {
      // Monaco fires the event after the model already holds the edit.
      value = nextValue;
      listener?.({ changes: [change] });
    },
    setEnabled(on) {
      enabled = on;
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

  expect(h.sent).toEqual(["providers typescript", "didOpen v1 abcX", "didChange v2 +Y"]);
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
  expect(h.sent).toEqual([
    "providers typescript",
    "didOpen v1 abcX",
    "providers typescript",
    "didOpen v1 abcXY",
  ]);
  expect(h.entry.lspOpened).toBe(true);
});

test("a file loaded with its language off opens when the language is turned on", async () => {
  const h = setup({ evicted: false });
  h.type("abcX", "+X");
  await h.resolveOpens();
  expect(h.sent).toEqual([]);
  expect(h.entry.lspOpened).toBe(false);

  h.setEnabled(true);
  void rehydrateEntryLspOpened(h.entry, h.deps);
  await h.resolveOpens();
  expect(h.sent).toEqual(["providers typescript", "didOpen v1 abcX"]);
  expect(h.entry.lspOpened).toBe(true);

  h.type("abcXY", "+Y");
  await h.resolveOpens();
  expect(h.sent.at(-1)).toBe("didChange v2 +Y");
});

test("an evicted file stays closed while its language is off", async () => {
  const h = setup();
  h.setEnabled(false);
  h.type("abcX", "+X");
  await h.resolveOpens();
  expect(h.sent).toEqual([]);
  expect(h.entry.lspOpened).toBe(false);
  expect(h.entry.lspNeedsRehydrate).toBe(true);
});

test("an open file sends each change before its handler returns", async () => {
  const h = setup({ evicted: false, enabledAtAttach: true });
  await h.resolveOpens();
  h.type("abcX", "+X");
  // Not awaited: a completion request Monaco makes for the same keystroke
  // goes out right after the handler, and must follow the change.
  expect(h.sent).toEqual(["providers typescript", "didOpen v57 abc", "didChange v58 +X"]);
});

test("a change typed while an earlier one waits for the open queues behind it", async () => {
  const h = setup({ evicted: false, enabledAtAttach: true });
  h.type("abcX", "+X");
  // The open has landed, but the first change has not been sent yet.
  h.entry.lspOpened = true;
  h.type("abcXY", "+Y");
  expect(h.sent).toEqual(["providers typescript", "didOpen v57 abc"]);
  await h.resolveOpens();
  expect(h.sent).toEqual([
    "providers typescript",
    "didOpen v57 abc",
    "didChange v58 +X",
    "didChange v59 +Y",
  ]);
});
