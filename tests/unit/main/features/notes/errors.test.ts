import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { registerNotesChannel } from "../../../../../src/main/features/notes";
import { NoteError } from "../../../../../src/main/features/notes/store";
import type { NoteContent } from "../../../../../src/shared/notes/types";
import { createIpcPair, resetInMemoryIpc, setupInMemoryRouter } from "../../../../helpers/ipc-pair";
import { mainErrorMock } from "../../../../log-test-spies";

const id = "123e4567-e89b-12d3-a456-426614174000";
const noteId = "n000000note";

beforeEach(resetInMemoryIpc);
afterEach(resetInMemoryIpc);

test("a missing note or workspace is a recoverable IPC result", async () => {
  await setupInMemoryRouter();
  const notes = registerNotesChannel({
    userData: "/unused",
    workspaces: () =>
      [{ id, name: "Workspace", location: { kind: "local", rootPath: "/workspace" } }] as never,
  });
  const read = spyOn(notes.store, "read").mockImplementation(
    (): Promise<NoteContent> => Promise.reject(new NoteError("not-found", "no such note")),
  );
  try {
    const ipc = createIpcPair().window.ipc;
    const logs = mainErrorMock.mock.calls.length;
    for (const workspaceId of [id, "123e4567-e89b-12d3-a456-426614174001"]) {
      expect(await ipc.call("notes", "read", { workspaceId, noteId })).toMatchObject({
        ok: false,
        kind: "not-found",
        category: "failed",
      });
    }
    expect(mainErrorMock.mock.calls.slice(logs)).toEqual([]);
  } finally {
    read.mockRestore();
  }
});
