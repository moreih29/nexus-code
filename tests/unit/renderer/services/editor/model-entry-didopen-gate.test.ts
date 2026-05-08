import { describe, expect, mock, test } from "bun:test";
import type { ModelEntryDeps } from "../../../../../src/renderer/services/editor/model/model-entry";

type Change = { text: string };

function deferred<T>() {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeFakeModel() {
  const listeners = new Set<(event: { changes: Change[] }) => void | Promise<void>>();
  return {
    getValue: () => "initial",
    setValue: () => {},
    getAlternativeVersionId: () => 1,
    getLanguageId: () => "typescript",
    onDidChangeContent(listener: (event: { changes: Change[] }) => void | Promise<void>) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    isDisposed: () => false,
    dispose: () => {},
    emitChange(text: string) {
      for (const listener of listeners) listener({ changes: [{ text }] });
    },
  };
}

const { cleanupEntry, createEntry } = await import(
  "../../../../../src/renderer/services/editor/model/model-entry.ts?didopen-gate"
);

function makeHarness(
  options: { didOpenPromise?: Promise<void>; origin?: "workspace" | "external" } = {},
) {
  const model = makeFakeModel();
  const notifyDidChange = mock(() => Promise.resolve());
  const notifyDidClose = mock(() => Promise.resolve());
  const notifyDidOpen = mock(() => options.didOpenPromise ?? Promise.resolve());
  const deps: ModelEntryDeps = {
    attachDirtyTracker: mock(() => undefined as any),
    detachDirtyTracker: mock(() => {}),
    markDirtyTrackerSaved: mock(() => {}),
    readFileForModel: mock(() => Promise.resolve({ content: "initial", isBinary: false } as any)),
    subscribeFsChanged: mock(() => () => {}),
    workspaceRootForInput: mock(() => "/workspace"),
    isLspLanguage: mock(() => true),
    ensureProvidersFor: mock(() => {}),
    monacoContentChangesToLsp: mock((changes: Change[]) => changes),
    notifyDidChange,
    notifyDidClose,
    notifyDidOpen,
    registerKnownModelUri: mock(() => {}),
    unregisterKnownModelUri: mock(() => {}),
    requireMonaco: mock(() => ({
      Uri: { parse: (raw: string) => ({ toString: () => raw }) },
      editor: {
        getModel: () => null,
        createModel: () => model,
      },
    })) as unknown as ModelEntryDeps["requireMonaco"],
  };
  const input = {
    workspaceId: "ws-1",
    filePath: "/workspace/src/a.ts",
    origin: options.origin,
    readOnly: options.origin === "external" ? true : undefined,
  };
  return { deps, input, model, notifyDidChange, notifyDidClose, notifyDidOpen };
}

describe("ModelEntry didOpen ordering gate", () => {
  test("didChange waits for didOpen before notifying LSP", async () => {
    const didOpen = deferred<void>();
    const harness = makeHarness({ didOpenPromise: didOpen.promise });
    const entry = createEntry(harness.input, "file:///workspace/src/a.ts", harness.deps);
    await entry.loadPromise;

    harness.model.emitChange("-one");
    await flushAsyncWork();
    expect(harness.notifyDidChange).not.toHaveBeenCalled();

    didOpen.resolve();
    await entry.didOpenPromise;
    await flushAsyncWork();

    expect(entry.lspOpened).toBe(true);
    expect(harness.notifyDidChange).toHaveBeenCalledTimes(1);
    expect(harness.notifyDidChange.mock.calls[0]?.[1]).toBe(2);
  });

  test("didOpen failure marks lspDegraded and subsequent didChange is skipped safely", async () => {
    const didOpen = deferred<void>();
    const harness = makeHarness({ didOpenPromise: didOpen.promise });
    const entry = createEntry(harness.input, "file:///workspace/src/a.ts", harness.deps);
    await entry.loadPromise;

    didOpen.reject(new Error("open failed"));
    await entry.didOpenPromise;
    harness.model.emitChange("-after-failure");
    await flushAsyncWork();

    expect(entry.lspDegraded).toBe(true);
    expect(entry.lspOpened).toBe(false);
    expect(harness.notifyDidChange).not.toHaveBeenCalled();
  });

  test("didClose waits when cleanup happens before didOpen settles", async () => {
    const didOpen = deferred<void>();
    const harness = makeHarness({ didOpenPromise: didOpen.promise });
    const entry = createEntry(harness.input, "file:///workspace/src/a.ts", harness.deps);
    await entry.loadPromise;

    cleanupEntry(entry);
    expect(entry.disposed).toBe(true);
    expect(harness.notifyDidClose).not.toHaveBeenCalled();

    didOpen.resolve();
    await entry.didOpenPromise;
    await flushAsyncWork();

    expect(harness.notifyDidClose).toHaveBeenCalledTimes(1);
    expect(harness.notifyDidClose.mock.calls[0]?.[0]).toBe("file:///workspace/src/a.ts");
  });

  test("forceDispose-style cleanup of external entry waits for in-flight didOpen", async () => {
    const didOpen = deferred<void>();
    const harness = makeHarness({ didOpenPromise: didOpen.promise, origin: "external" });
    const entry = createEntry(harness.input, "file:///workspace/src/a.ts", harness.deps);
    await entry.loadPromise;

    cleanupEntry(entry);
    await flushAsyncWork();
    expect(harness.notifyDidClose).not.toHaveBeenCalled();

    didOpen.resolve();
    await entry.didOpenPromise;
    await flushAsyncWork();

    expect(entry.origin).toBe("external");
    expect(entry.originatingWorkspaceId).toBe("ws-1");
    expect(harness.notifyDidClose).toHaveBeenCalledTimes(1);
  });

  test("multiple didChanges keep monotonically increasing versions while gated", async () => {
    const didOpen = deferred<void>();
    const harness = makeHarness({ didOpenPromise: didOpen.promise });
    const entry = createEntry(harness.input, "file:///workspace/src/a.ts", harness.deps);
    await entry.loadPromise;

    harness.model.emitChange("-one");
    harness.model.emitChange("-two");
    expect(entry.version).toBe(3);
    expect(harness.notifyDidChange).not.toHaveBeenCalled();

    didOpen.resolve();
    await entry.didOpenPromise;
    await flushAsyncWork();

    expect(harness.notifyDidChange.mock.calls.map((call) => call[1])).toEqual([2, 3]);
  });
});
