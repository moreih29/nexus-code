import { afterEach, beforeEach, expect, jest, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { NoteError } from "../../../../../src/main/features/notes/store";
import { trackAppWindow } from "../../../../../src/main/features/window/app-windows";
import { linkedTask } from "../../../../../src/shared/notes/line-report";
import type { NoteContent } from "../../../../../src/shared/notes/types";
import { MAX_NOTE_ANSWER_BYTES } from "../../../../../src/shared/types/notes";
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

test("a task's linked chat reports into the parent's note and broadcasts link changes", async () => {
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
      link: { ...tab, kind: "task" },
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
    await notes.store.save(parent, noteId, {
      doc: {
        type: "doc",
        content: [
          {
            type: "taskList",
            content: [
              {
                type: "taskItem",
                attrs: { nexusLink: linkId, checked: false },
                content: [{ type: "paragraph", content: [{ type: "text", text: "Add tests" }] }],
              },
            ],
          },
        ],
      },
    });
    const open = await notes.store.read(parent, noteId);
    const report = {
      linkId,
      check: true,
      result: { state: "done", summary: "Passed", at: 1 },
    } as const;
    expect(await notes.reportLine({ ...tab, agent: "codex" }, noteId, report)).toBe(true);
    const reportedAt = (await notes.store.read(parent, noteId)).updatedAt;
    // A closing editor flushes the draft it captured before receiving lineReported.
    const draft = {
      ...open.doc,
      type: "doc" as const,
      content: [
        ...(open.doc.content ?? []),
        { type: "paragraph", content: [{ type: "text", text: "Unsaved edit" }] },
      ],
    };
    expect(
      await ipc.call("notes", "save", {
        workspaceId: id,
        noteId,
        doc: draft,
        baseUpdatedAt: open.updatedAt,
      }),
    ).toMatchObject({ ok: true });
    const merged = await notes.store.read(parent, noteId);
    expect(merged.doc.content?.at(-1)).toEqual(draft.content.at(-1));
    expect(linkedTask(merged.doc, linkId)).toMatchObject({
      attrs: { checked: true },
      content: [
        expect.anything(),
        { attrs: { nexusOrigin: `report:${linkId}` }, content: [{ type: "text", text: "Passed" }] },
      ],
    });
    // Once the editor has seen the report, it may uncheck the item and delete the paragraph.
    expect(
      await ipc.call("notes", "save", {
        workspaceId: id,
        noteId,
        doc: draft,
        baseUpdatedAt: reportedAt,
      }),
    ).toMatchObject({ ok: true });
    expect((await notes.store.read(parent, noteId)).doc).toEqual(draft);
    expect(
      await other.call("notes", "removeLink", { workspaceId: id, noteId, linkId }),
    ).toMatchObject({ ok: true });
    expect(await ipc.call("notes", "links", { workspaceId: taskId, noteId })).toMatchObject({
      ok: true,
      value: [],
    });
    const place = { locationKey: parent.key, noteId };
    expect(broadcast.mock.calls).toEqual([
      ["notes", "linksChanged", place],
      ["notes", "linksChanged", place],
      ["notes", "linksChanged", place],
      ["notes", "lineReported", { ...place, ...report, updatedAt: reportedAt }],
      ["notes", "changed", { ...place, change: "saved" }],
      ["notes", "changed", { ...place, change: "saved" }],
      ["notes", "changed", { ...place, change: "saved" }],
      ["notes", "linksChanged", place],
    ]);
  } finally {
    broadcast.mockRestore();
    notes.dispose();
    await rm(userData, { recursive: true, force: true });
  }
});

test("a committed link result announces itself when the note document write fails", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "note-report-ipc-"));
  const router = await setupInMemoryRouter();
  const broadcast = spyOn(router, "broadcast");
  const notes = registerNotesChannel({
    userData,
    workspaces: () =>
      [{ id, name: "Workspace", location: { kind: "local", rootPath: "/workspace" } }] as never,
  });
  const rename = fs.rename;
  const failSave = spyOn(fs, "rename");
  try {
    const location = notes.locationOf(id);
    const note = await notes.store.create(location, "Review");
    const tab = {
      agent: "codex",
      workspaceId: id,
      tabId: "tab",
      cwd: "/workspace",
      title: "Title",
    } as const;
    const { id: linkId } = await notes.store.addLink(location, note.id, { ...tab, kind: "line" });
    await notes.store.save(location, note.id, {
      doc: {
        type: "doc",
        content: [
          {
            type: "taskList",
            content: [
              { type: "taskItem", attrs: { nexusLink: linkId }, content: [{ type: "paragraph" }] },
            ],
          },
        ],
      },
    });
    failSave.mockImplementation((from, to) =>
      to === path.join(note.dir, "note.json")
        ? Promise.reject(new Error("document failed"))
        : rename(from, to),
    );
    const result = { state: "done", summary: "Passed", at: 1 } as const;
    await expect(notes.reportLine(tab, note.id, { linkId, check: true, result })).rejects.toThrow(
      "document failed",
    );
    expect((await notes.store.links(location, note.id))[0].link.result).toEqual(result);
    expect(broadcast.mock.calls).toEqual([
      ["notes", "linksChanged", { locationKey: location.key, noteId: note.id }],
    ]);
  } finally {
    failSave.mockRestore();
    broadcast.mockRestore();
    notes.dispose();
    await rm(userData, { recursive: true, force: true });
  }
});

test("two windows share one automatic summary and one completion toast for an SSH note", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "note-summary-ipc-"));
  const router = await setupInMemoryRouter();
  const broadcast = spyOn(router, "broadcast");
  const releaseSummary = Promise.withResolvers<void>();
  const runClaude = mock(async ({ stdin }: { stdin: string }) => {
    expect(stdin).toContain("[0:20 | 20000] S1: Confirmed");
    await releaseSummary.promise;
    return { output: { summary: ["Confirmed"], todos: [] } };
  });
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
      runClaude,
    },
  });
  const first = createIpcPair();
  const second = createIpcPair();
  const windows = [first, second].map(({ sender }, index) => {
    const win = Object.assign(new EventEmitter(), {
      webContents: sender,
      isVisible: () => true,
      isMinimized: () => false,
      isDestroyed: () => sender.isDestroyed(),
      isFocused: () => index === 0,
    });
    trackAppWindow(win as unknown as BrowserWindow);
    return win;
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
    const ipc = first.window.ipc;
    const other = second.window.ipc;
    const completion = Promise.withResolvers<unknown>();
    const firstCompletion = mock(completion.resolve);
    ipc.listen("notes", "summaryCompleted", firstCompletion);
    const otherCompletion = mock(() => {});
    other.listen("notes", "summaryCompleted", otherCompletion);
    const linked = { ok: true, value: [{ noteId: note.id, title: "Review" }] };
    expect(await ipc.call("notes", "linksOfConversation", tab)).toMatchObject(linked);
    const requests = await Promise.all([
      ipc.call("notes", "summarize", { ...args, mode: "auto" }),
      other.call("notes", "summarize", { ...args, mode: "auto" }),
    ]);
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ok: true, value: null }),
        expect.objectContaining({ ok: true, value: expect.objectContaining({ state: "running" }) }),
      ]),
    );
    const session = "summary-linked-session";
    expect(await ipc.call("notes", "updateLink", { tab: { ...tab, session } })).toMatchObject({
      ok: true,
    });
    releaseSummary.resolve();
    await notes.waitForWrites();
    expect(await completion.promise).toMatchObject({
      workspaceId: id,
      noteId: note.id,
      title: "Review",
      todos: 0,
    });
    expect(runClaude).toHaveBeenCalledTimes(1);
    expect(firstCompletion).toHaveBeenCalledTimes(1);
    expect(otherCompletion).not.toHaveBeenCalled();
    expect(
      await other.call("notes", "summaries", { workspaceId: id, noteId: note.id }),
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
    await other.call("notes", "summaryVisibility", {
      workspaceId: id,
      noteId: note.id,
      tabId: "note-tab",
      visible: true,
    });
    const unexpected = mock(() => {});
    ipc.listen("notes", "summaryCompleted", unexpected);
    expect(await ipc.call("notes", "summarize", { ...args, mode: "rerun" })).toMatchObject({
      ok: true,
      value: { state: "running" },
    });
    await notes.waitForWrites();
    expect(unexpected).not.toHaveBeenCalled();
    expect(otherCompletion).not.toHaveBeenCalled();
    expect(await ipc.call("notes", "dismiss", args)).toMatchObject({ ok: true });
    expect(await other.call("notes", "summaries", args)).toMatchObject({
      ok: true,
      value: { [recordingId]: { state: "done", seen: true } },
    });
  } finally {
    releaseSummary.resolve();
    await notes.waitForWrites();
    for (const win of windows) win.emit("closed");
    broadcast.mockRestore();
    notes.dispose();
    await rm(userData, { recursive: true, force: true });
  }
});

test("summary IPC rejects malformed note and recording IDs", async () => {
  const notes = await setupNotes();
  try {
    const ipc = createIpcPair().window.ipc;
    for (const method of ["summarize", "cancel", "undo", "dismiss"]) {
      for (const args of [
        { workspaceId: id, noteId: "../note", recordingId: "r000000abcd" },
        { workspaceId: id, noteId, recordingId: "../recording" },
      ]) {
        expect(await ipc.call("notes", method, args)).toMatchObject({
          ok: false,
          kind: "invalid-args",
        });
      }
    }
  } finally {
    notes.dispose();
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

test("saving an answer broadcasts the stored card and a stale autosave keeps the quote", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "note-card-ipc-"));
  const router = await setupInMemoryRouter();
  const broadcast = spyOn(router, "broadcast");
  const notes = registerNotesChannel({
    userData,
    workspaces: () =>
      [{ id, name: "Workspace", location: { kind: "local", rootPath: "/workspace" } }] as never,
  });
  try {
    const ipc = createIpcPair().window.ipc;
    const location = notes.locationOf(id);
    const open = await notes.store.create(location, "Review");
    const caller = {
      agent: "codex",
      tabId: "tab",
      session: "thread",
      messageId: "turn",
      cwd: "/workspace",
      title: "Conversation",
    } as const;
    const request = {
      workspaceId: id,
      noteId: open.id,
      markdown: "Answ\u202eer ![chart](file:///private).\n\n```txt\n\u2066data\u2069\n```",
      imageAlt: "Image",
      source: caller,
    };
    const results = await Promise.all([
      ipc.call("notes", "saveAnswer", request),
      ipc.call("notes", "saveAnswer", request),
    ]);
    expect(results[0]).toMatchObject({ ok: true, value: { noteId: open.id, saved: true } });
    expect(results[1]).toMatchObject({ ok: true, value: { noteId: open.id, saved: false } });
    expect(await notes.store.links(location, open.id)).toHaveLength(1);
    const [{ id: linkId, link }] = await notes.store.links(location, open.id);
    expect(link).toMatchObject({ ...caller, workspaceId: id, kind: "card" });
    const stored = await notes.store.read(location, open.id);
    const [card] = stored.doc.content ?? [];
    expect(card).toMatchObject({ type: "blockquote", attrs: { nexusLink: linkId } });
    expect(JSON.stringify(card)).not.toMatch(/\p{Cf}/u);
    expect(broadcast).toHaveBeenCalledWith("notes", "blocksAdded", {
      locationKey: location.key,
      noteId: open.id,
      updatedAt: stored.updatedAt,
      blocks: [card],
    });
    const edited = { type: "paragraph", content: [{ type: "text", text: "Concurrent edit" }] };
    expect(
      await ipc.call("notes", "save", {
        workspaceId: id,
        noteId: open.id,
        doc: { type: "doc", content: [edited] },
        baseUpdatedAt: open.updatedAt,
      }),
    ).toMatchObject({ ok: true });
    expect((await notes.store.read(location, open.id)).doc.content).toEqual([edited, card]);
    expect(await fs.readFile(path.join(open.dir, "note.md"), "utf8")).toBe(
      "# Review\n\nConcurrent edit\n\n> Answer chart.\n>\n> ```txt\n> data\n> ```\n",
    );
    expect(
      await ipc.call("notes", "save", {
        workspaceId: id,
        noteId: open.id,
        doc: { type: "doc", content: [edited] },
        baseUpdatedAt: stored.updatedAt,
      }),
    ).toMatchObject({ ok: true });
    expect((await notes.store.read(location, open.id)).doc.content).toEqual([edited]);

    const newNote = await ipc.call("notes", "saveAnswer", {
      workspaceId: id,
      markdown: "New quote",
      imageAlt: "Image",
      source: caller,
    });
    expect(newNote).toMatchObject({
      ok: true,
      value: { noteId: expect.any(String), saved: true },
    });
    if (!newNote.ok) throw new Error("New note failed");
    expect(newNote.value.noteId).not.toBe(open.id);
    expect(await notes.store.list(location)).toHaveLength(2);
  } finally {
    notes.dispose();
    broadcast.mockRestore();
    await rm(userData, { recursive: true, force: true });
  }
});

test("answer saves reject oversized text and remove new notes when the card write fails", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "note-card-failure-"));
  await setupInMemoryRouter();
  const notes = registerNotesChannel({
    userData,
    workspaces: () =>
      [{ id, name: "Workspace", location: { kind: "local", rootPath: "/workspace" } }] as never,
  });
  const rename = fs.rename;
  let documentWrites = 0;
  const failWrite = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (path.basename(String(to)) === "note.json" && ++documentWrites === 2)
      throw new Error("Cannot store the card");
    return rename(from, to);
  });
  try {
    const ipc = createIpcPair().window.ipc;
    const request = {
      workspaceId: id,
      imageAlt: "Image",
      source: {
        agent: "codex",
        tabId: "tab",
        messageId: "turn",
        cwd: "/workspace",
        title: "Conversation",
      },
    } as const;
    expect(
      await ipc.call("notes", "saveAnswer", {
        ...request,
        markdown: "한".repeat(Math.ceil(MAX_NOTE_ANSWER_BYTES / 3)),
      }),
    ).toMatchObject({ ok: false, kind: "invalid-args" });
    expect(documentWrites).toBe(0);
    expect(await ipc.call("notes", "saveAnswer", { ...request, markdown: "Answer" })).toMatchObject(
      {
        ok: false,
      },
    );
    expect(documentWrites).toBe(2);
    expect(await notes.store.list(notes.locationOf(id))).toEqual([]);
  } finally {
    failWrite.mockRestore();
    notes.dispose();
    await rm(userData, { recursive: true, force: true });
  }
});
