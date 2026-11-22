import { afterEach, beforeEach, expect, jest, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NoteError } from "../../../../../src/main/features/notes/store";
import type { NoteContent } from "../../../../../src/shared/notes/types";
import {
  createIpcPair,
  mockGetAllWebContents,
  mockIpcMain,
  resetInMemoryIpc,
  setupInMemoryRouter,
} from "../../../../helpers/ipc-pair";
import { mainErrorMock } from "../../../../log-test-spies";

let appPath: string;
const sent = Promise.withResolvers<void>();
const child = Object.assign(new EventEmitter(), {
  kill: mock(() => true),
  postMessage: mock(() => sent.resolve()),
});

mock.module("electron", () => ({
  app: { isPackaged: false, getAppPath: () => appPath },
  ipcMain: mockIpcMain,
  webContents: { getAllWebContents: mockGetAllWebContents },
  utilityProcess: { fork: () => child },
}));

const { registerNotesChannel } = await import("../../../../../src/main/features/notes");

const id = "123e4567-e89b-12d3-a456-426614174000";
const noteId = "n000000note";
const update = { workspaceId: id, noteId, recordedMs: 0, paused: false };

beforeEach(resetInMemoryIpc);
afterEach(resetInMemoryIpc);

/** Registers the notes channel for a single workspace without reaching disk. */
async function setupNotes() {
  await setupInMemoryRouter();
  return registerNotesChannel({
    userData: "/unused",
    workspaces: () =>
      [{ id, name: "Workspace", location: { kind: "local", rootPath: "/workspace" } }] as never,
  });
}

test("notes shutdown stops its voice worker and settles an outstanding request", async () => {
  jest.useFakeTimers();
  appPath = await mkdtemp(path.join(tmpdir(), "notes-shutdown-"));
  try {
    const models = path.join(appPath, "resources", "voice-print");
    await mkdir(models, { recursive: true });
    await writeFile(path.join(models, "campp-zh-en.onnx"), "");
    await setupInMemoryRouter();
    const notes = registerNotesChannel({ userData: appPath, workspaces: () => [] });
    const pair = createIpcPair();
    const result = pair.window.ipc.call("notes", "voicePrint", {
      audio: new Float32Array([0.5]),
    });
    await sent.promise;
    notes.dispose();

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(await result).toMatchObject({ ok: true, value: null });
  } finally {
    child.emit("exit", 0);
    jest.useRealTimers();
    await rm(appPath, { recursive: true, force: true });
  }
});

test("notes shutdown waits for a save started by a renderer that has closed", async () => {
  const notes = await setupNotes();
  const finishedWrite = Promise.withResolvers<void>();
  const startedWrite = Promise.withResolvers<void>();
  const save = spyOn(notes.store, "save").mockImplementation(async () => {
    startedWrite.resolve();
    await finishedWrite.promise;
    return { title: "Kept" } as never;
  });
  const pair = createIpcPair();
  const saving = pair.window.ipc.call("notes", "save", {
    workspaceId: id,
    noteId: "n000000note",
    title: "Kept",
  });
  await startedWrite.promise;
  pair.sender.destroy();
  let done = false;
  const drained = notes.waitForWrites().then(() => {
    done = true;
  });
  try {
    await Promise.resolve();
    expect(done).toBe(false);
  } finally {
    finishedWrite.resolve();
    await drained;
    expect(await saving).toMatchObject({ ok: true });
    save.mockRestore();
    notes.dispose();
  }
});

test("a missing note or workspace is a recoverable IPC result", async () => {
  const notes = await setupNotes();
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

test("a task's linked chat updates the parent's note and broadcasts link changes", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "note-links-ipc-"));
  const taskId = "123e4567-e89b-12d3-a456-426614174001";
  const router = await setupInMemoryRouter();
  const broadcast = spyOn(router, "broadcast");
  const notes = registerNotesChannel({
    userData,
    workspaces: () =>
      [
        { id, name: "Workspace", location: { kind: "local", rootPath: "/workspace" } },
        {
          id: taskId,
          name: "Task",
          task: { parentId: id },
          location: { kind: "local", rootPath: "/task" },
        },
      ] as never,
  });
  try {
    const parent = notes.locationOf(id);
    const { id: noteId } = await notes.store.create(parent, "Shared note");
    const ipc = createIpcPair().window.ipc;
    const other = createIpcPair().window.ipc;
    const tab = { agent: "codex", workspaceId: taskId, tabId: "tab", cwd: "/task", title: "Title" };
    const result = await ipc.call("notes", "addLink", {
      workspaceId: taskId,
      noteId,
      link: { ...tab, kind: "note" },
    });
    expect(result).toMatchObject({ ok: true });
    const [{ id: linkId }] = await notes.store.links(parent, noteId);
    expect(
      await ipc.call("notes", "updateLink", { tab: { ...tab, session: "thread" } }),
    ).toMatchObject({ ok: true });
    expect(await other.call("notes", "links", { workspaceId: id, noteId })).toMatchObject({
      ok: true,
      value: [{ id: linkId, link: { workspaceId: taskId, session: "thread" } }],
    });
    expect(
      await other.call("notes", "removeLink", { workspaceId: id, noteId, linkId }),
    ).toMatchObject({ ok: true });
    expect(await ipc.call("notes", "links", { workspaceId: taskId, noteId })).toMatchObject({
      ok: true,
      value: [],
    });
    expect(broadcast.mock.calls).toEqual(
      Array.from({ length: 3 }, () => [
        "notes",
        "linksChanged",
        { locationKey: parent.key, noteId },
      ]),
    );
  } finally {
    broadcast.mockRestore();
    notes.dispose();
    await rm(userData, { recursive: true, force: true });
  }
});

test("an SSH note summarizes and undoes locally while its conversation index stays current", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "note-summary-ipc-"));
  const router = await setupInMemoryRouter();
  const broadcast = spyOn(router, "broadcast");
  const releaseSummary = Promise.withResolvers<void>();
  const notes = registerNotesChannel({
    userData,
    workspaces: () =>
      [
        { id, name: "SSH", location: { kind: "ssh", host: "fixture", remotePath: "/project" } },
      ] as never,
    summary: {
      settings: () => ({ enabled: true, agent: "claude" }),
      language: () => "en",
      profile: (id) => ({ id, agent: "claude", dir: "", name: "", color: "" }),
      runClaude: async ({ stdin }) => {
        expect(stdin).toContain("[0:20 | 20000] S1: Confirmed");
        await releaseSummary.promise;
        return { output: { summary: ["Confirmed"], todos: [] } };
      },
    },
  });
  try {
    const location = notes.locationOf(id);
    const note = await notes.store.create(location, "Review");
    const tab = {
      agent: "claude" as const,
      workspaceId: id,
      tabId: "chat",
      cwd: "/project",
      title: "Linked chat",
    };
    await notes.store.addLink(location, note.id, { ...tab, kind: "note" });
    const recordingId = "r000000abcd";
    await notes.store.saveTranscript(location, note.id, {
      version: 1,
      recordings: [
        {
          id: recordingId,
          startedAt: 1,
          language: "en",
          takes: [],
          speakers: {},
          lines: [0, 10_000, 20_000].map((startMs) => ({
            speaker: "1",
            text: "Confirmed",
            startMs,
            endMs: startMs + 10_000,
          })),
        },
      ],
    });
    const args = { workspaceId: id, noteId: note.id, recordingId };
    const ipc = createIpcPair().window.ipc;
    const linked = { ok: true, value: [{ noteId: note.id, title: "Review" }] };
    expect(await ipc.call("notes", "linksOfConversation", tab)).toMatchObject(linked);
    expect(await ipc.call("notes", "summarize", args)).toMatchObject({
      ok: true,
      value: { state: "running" },
    });
    const session = "summary-linked-session";
    expect(await ipc.call("notes", "updateLink", { tab: { ...tab, session } })).toMatchObject({
      ok: true,
    });
    releaseSummary.resolve();
    await notes.waitForWrites();
    expect(
      await ipc.call("notes", "summaries", { workspaceId: id, noteId: note.id }),
    ).toMatchObject({
      ok: true,
      value: { [recordingId]: { state: "done" } },
    });
    const reopened = { ...tab, tabId: "reopened", session };
    expect(await ipc.call("notes", "linksOfConversation", reopened)).toMatchObject(linked);
    expect(await ipc.call("notes", "undo", args)).toMatchObject({ ok: true, value: 3 });
    expect(await ipc.call("notes", "linksOfConversation", reopened)).toMatchObject(linked);
    expect(broadcast.mock.calls.map(([, event]) => event)).toEqual([
      "summaryChanged",
      "linksChanged",
      "blocksAdded",
      "changed",
      "summaryChanged",
      "summaryChanged",
      "blocksRemoved",
      "changed",
    ]);
  } finally {
    releaseSummary.resolve();
    broadcast.mockRestore();
    notes.dispose();
    await rm(userData, { recursive: true, force: true });
  }
});

test.each([
  "stopped",
  "closed",
  "was removed",
] as const)("a delayed title lookup cannot restore a recording that %s", async (outcome) => {
  const notes = await setupNotes();
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
