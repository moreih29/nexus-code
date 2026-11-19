import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { registerNotesChannel } from "../../../../../src/main/features/notes";
import { createIpcPair, resetInMemoryIpc, setupInMemoryRouter } from "../../../../helpers/ipc-pair";

const id = "123e4567-e89b-12d3-a456-426614174000";
const update = { workspaceId: id, noteId: "n000000note", recordedMs: 0, paused: false };

beforeEach(resetInMemoryIpc);
afterEach(resetInMemoryIpc);

test.each([
  "stopped",
  "closed",
  "was removed",
] as const)("a delayed title lookup cannot restore a recording that %s", async (outcome) => {
  await setupInMemoryRouter();
  const notes = registerNotesChannel({
    userData: "/unused",
    workspaces: () =>
      [{ id, name: "Workspace", location: { kind: "local", rootPath: "/workspace" } }] as never,
  });
  const lookup = Promise.withResolvers<void>();
  const title = Promise.withResolvers<Awaited<ReturnType<typeof notes.store.read>>>();
  const read = spyOn(notes.store, "read").mockImplementationOnce(() => {
    lookup.resolve();
    return title.promise;
  });
  const pair = createIpcPair();
  const start = pair.window.ipc.call("notes", "recording", { now: update });
  try {
    await lookup.promise;
    if (outcome === "stopped") await pair.window.ipc.call("notes", "recording", { now: null });
    else if (outcome === "closed") pair.sender.destroy();
    else notes.forgetWorkspace(id);

    title.resolve({ title: "A note" } as never);
    await start;
    expect(notes.recording()).toBeUndefined();
  } finally {
    read.mockRestore();
  }
});
