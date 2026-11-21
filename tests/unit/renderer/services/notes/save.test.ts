import { expect, mock, test } from "bun:test";
import {
  createNoteAutoSave,
  registerNoteSave,
} from "../../../../../src/renderer/services/notes/save";
import { installLayoutClosePersistence } from "../../../../../src/renderer/state/persistence";

test.each([
  true,
  false,
])("window close flushes scheduled note edits and acknowledges their outcome (%p)", async (saved) => {
  const previousWindow = globalThis.window;
  const result = Promise.withResolvers<void>();
  const prepared = Promise.withResolvers<unknown>();
  const save = mock((_change: { title?: string }) => result.promise);
  const note = createNoteAutoSave(save, () => {});
  const unregister = registerNoteSave(note.flush);
  let prepareClose: ((args: { attempt: number }) => void) | undefined;
  const call = mock(async (_channel: string, method: string, args: unknown) => {
    if (method === "closePrepared") prepared.resolve(args);
  });
  globalThis.window = {
    ipc: {
      call,
      listen(_channel: string, _event: string, onPrepare: typeof prepareClose) {
        prepareClose = onPrepare;
        return () => {};
      },
    },
  } as unknown as typeof window;
  const unlisten = installLayoutClosePersistence();
  try {
    note.schedule({ title: "Pending title" });
    expect(save).not.toHaveBeenCalled();
    if (!prepareClose) throw new Error("missing close listener");
    prepareClose({ attempt: 1 });
    expect(save).toHaveBeenCalledWith({ title: "Pending title" });
    expect(call).not.toHaveBeenCalled();
    if (saved) result.resolve();
    else result.reject(new Error("disk write failed"));
    expect(await prepared.promise).toEqual({ attempt: 1, saved });
  } finally {
    note.discard();
    unregister();
    unlisten();
    globalThis.window = previousWindow;
  }
});

test("flushing waits for in-flight note edits and the changes queued during the write", async () => {
  const first = Promise.withResolvers<void>();
  const save = mock(async (_change: { title?: string }) => {});
  save.mockImplementationOnce(() => first.promise);
  const note = createNoteAutoSave(save, () => {});
  note.schedule({ title: "Old" });
  const writing = note.flush();
  note.schedule({ title: "New" });
  const closing = note.flush();
  expect(save).toHaveBeenCalledTimes(1);
  first.resolve();
  expect(await closing).toBe(true);
  expect(await writing).toBe(true);
  expect(save.mock.calls).toEqual([[{ title: "Old" }], [{ title: "New" }]]);
});
