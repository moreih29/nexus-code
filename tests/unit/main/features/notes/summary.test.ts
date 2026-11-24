import { afterEach, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Schema } from "@tiptap/pm/model";
import { NotesStore } from "../../../../../src/main/features/notes/store";
import {
  NotesSummary,
  type NotesSummaryOptions,
} from "../../../../../src/main/features/notes/summary";
import { type DocNode, docToMarkdown } from "../../../../../src/shared/notes/markdown";
import { summaryOrigin } from "../../../../../src/shared/notes/summary";
import type { TranscriptRecording } from "../../../../../src/shared/notes/transcript";
import type { NoteLocation } from "../../../../../src/shared/notes/types";

const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

const location: NoteLocation = {
  key: "ssh:host:/project",
  kind: "ssh",
  path: "/project",
  label: "SSH",
};
const recording: TranscriptRecording = {
  id: "r000000abcd",
  language: "ko",
  startedAt: Date.UTC(2026, 10, 17, 14),
  speakers: { "3": "한여울" },
  takes: [],
  lines: [
    { speaker: "3", startMs: 0, endMs: 10_000, text: "첫 번째 문장" },
    { speaker: "1", startMs: 18_000, endMs: 36_000, text: "두 번째 문장" },
    { speaker: "3", startMs: 45_000, endMs: 55_000, text: "세 번째 문장" },
  ],
};
const profile = { id: "claude-default", agent: "claude" as const, name: "", color: "", dir: "" };
const output = {
  summary: ["테스트가 남았습니다"],
  todos: [{ text: "정상 둘 · 장애 하나 테스트 추가", speaker: "S1", atMs: 45_000 }],
};
const paragraph = (text: string): DocNode => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

async function setup(overrides: Partial<NotesSummaryOptions> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "notes-summary-test-"));
  temporary.push(root);
  const store = new NotesStore(root);
  const note = await store.create(location, "출시 전 점검");
  await store.saveTranscript(location, note.id, { version: 1, recordings: [recording] });
  const target = { location, noteId: note.id, recordingId: recording.id };
  const defaults: NotesSummaryOptions = {
    store,
    profile: () => profile,
    settings: () => ({ enabled: true, agent: "claude" }),
    language: () => "ko",
    runClaude: async () => ({ output }),
    append: ({ location, noteId }, blocks) => store.appendBlocks(location, noteId, blocks),
    onState: () => {},
    onRemoved: () => {},
  };
  const options = { ...defaults, ...overrides };
  return { options, store, target, summaries: new NotesSummary(options) };
}

test("concurrent calls deduplicate by recording and only manual retry can recover a failure", async () => {
  const runClaude = mock<NotesSummaryOptions["runClaude"]>(async () => ({
    error: { kind: "limit" },
  }));
  const { summaries, target } = await setup({ runClaude });
  const attempts = await Promise.all(
    Array.from({ length: 5 }, () => summaries.summarize(target, "auto")),
  );
  expect(attempts.filter(Boolean)).toHaveLength(1);
  await summaries.waitForIdle();
  expect(await summaries.states(location, target.noteId)).toMatchObject({
    [recording.id]: { state: "failed", error: { kind: "limit" } },
  });
  expect(await summaries.summarize(target, "auto")).toBeNull();
  expect(runClaude).toHaveBeenCalledTimes(1);
  runClaude.mockResolvedValueOnce({ output });
  await summaries.summarize(target, "retry");
  await summaries.waitForIdle();
  expect(runClaude).toHaveBeenCalledTimes(2);
  expect(await summaries.summarize(target, "auto")).toBeNull();
  expect(await summaries.dismiss(target)).toBe(true);
  expect(await summaries.states(location, target.noteId)).toMatchObject({
    [recording.id]: { state: "done", seen: true },
  });
  expect(await summaries.undo(target)).toBe(0);
});

test("a failed summary is recorded by its kind alone, never the agent's words", async () => {
  const recordError = mock<NonNullable<NotesSummaryOptions["recordError"]>>(() => {});
  const runClaude = mock<NotesSummaryOptions["runClaude"]>(async () => ({
    error: { kind: "failed", message: "첫 번째 문장 was not summarized" },
  }));
  const { summaries, target } = await setup({ runClaude, recordError });
  await summaries.summarize(target, "auto");
  await summaries.waitForIdle();
  expect(recordError.mock.calls).toEqual([["notes", "summary:failed"]]);
  await summaries.cancel(target);
  expect(recordError).toHaveBeenCalledTimes(1);
});

test("the queue serializes notes and cancellation skips queued work and aborts the running call", async () => {
  const started = Promise.withResolvers<void>();
  const runClaude = mock<NotesSummaryOptions["runClaude"]>(async ({ signal }) => {
    started.resolve();
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return { output };
  });
  const { summaries, store, target } = await setup({ runClaude });
  const second = await store.create(location, "Queued");
  await store.saveTranscript(location, second.id, { version: 1, recordings: [recording] });
  const queued = { ...target, noteId: second.id };
  await summaries.summarize(target, "auto");
  await started.promise;
  await summaries.summarize(queued, "auto");
  expect(runClaude).toHaveBeenCalledTimes(1);
  expect(await summaries.cancel(queued)).toBe(true);
  expect(await summaries.cancel(target)).toBe(true);
  await summaries.waitForIdle();
  expect(runClaude).toHaveBeenCalledTimes(1);
  for (const { noteId } of [target, queued]) {
    expect(await summaries.states(location, noteId)).toMatchObject({
      [recording.id]: { state: "failed", error: { kind: "interrupted" } },
    });
    expect(docToMarkdown((await store.read(location, noteId)).doc)).toBe("");
  }
});

test("restart marks stale runs interrupted and a retry recovers blocks committed before the state", async () => {
  const runClaude = mock<NotesSummaryOptions["runClaude"]>(async () => ({ output }));
  const { options, summaries, store, target } = await setup({ runClaude });
  await summaries.summarize(target, "auto");
  await summaries.waitForIdle();
  const { noteId, recordingId } = target;
  await store.editSummary(location, noteId, recordingId, async () => ({
    next: { state: "running", agent: "claude", runId: randomUUID(), startedAt: 1, seen: false },
  }));
  const restarted = new NotesSummary(options);
  expect(await restarted.states(location, noteId)).toMatchObject({
    [recordingId]: { state: "failed", error: { kind: "interrupted" } },
  });
  await restarted.summarize(target, "retry");
  await restarted.waitForIdle();
  expect(runClaude).toHaveBeenCalledTimes(1);
  expect(await restarted.states(location, noteId)).toMatchObject({
    [recordingId]: { state: "done", todos: 1 },
  });
});

test("undo removes only matching top-level blocks and manual rerun replaces its previous summary", async () => {
  const onRemoved = mock(() => {});
  const { summaries, store, target } = await setup({ onRemoved });
  const { noteId, recordingId } = target;
  const nexusOrigin = summaryOrigin(recordingId);
  const handwritten: DocNode = {
    type: "blockquote",
    content: [{ ...paragraph("Keep nested match"), attrs: { nexusOrigin } }],
  };
  const unrelated: DocNode = {
    ...paragraph("Keep other summary"),
    attrs: { nexusOrigin: "summary:other" },
  };
  await store.appendBlocks(location, noteId, [handwritten, unrelated]);
  await summaries.summarize(target, "auto");
  await summaries.waitForIdle();
  expect(docToMarkdown((await store.read(location, noteId)).doc)).toContain(
    "- [ ] 정상 둘 · 장애 하나 테스트 추가 — 한여울 0:45",
  );
  await summaries.summarize(target, "rerun");
  await summaries.waitForIdle();
  const { doc } = await store.read(location, noteId);
  expect(doc.content?.filter((block) => block.attrs?.nexusOrigin === nexusOrigin)).toHaveLength(5);
  expect(await summaries.undo(target)).toBe(5);
  expect((await store.read(location, noteId)).doc.content).toEqual([handwritten, unrelated]);
  expect(onRemoved.mock.calls).toEqual([
    [target, nexusOrigin],
    [target, nexusOrigin],
  ]);
  expect(await summaries.states(location, noteId)).toMatchObject({
    [recordingId]: { state: "undone" },
  });
  expect(await summaries.summarize(target, "auto")).toBeNull();
});

test("an older editor drops unknown attributes with all summary text and tasks intact", async () => {
  const { summaries, store, target } = await setup();
  await summaries.summarize(target, "auto");
  await summaries.waitForIdle();
  const { noteId, recordingId } = target;
  const { doc } = await store.read(location, noteId);
  const legacy = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { group: "block", content: "text*" },
      heading: { group: "block", content: "text*", attrs: { level: { default: 1 } } },
      bulletList: { group: "block", content: "listItem+" },
      listItem: { content: "paragraph block*" },
      taskList: { group: "block", content: "taskItem+" },
      taskItem: { content: "paragraph block*", attrs: { checked: { default: false } } },
      text: {},
    },
  });
  expect(doc.content?.[2].attrs?.nexusOrigin).toBe(summaryOrigin(recordingId));
  const older = legacy.nodeFromJSON(doc);
  older.check();
  expect(older.textContent).toContain(output.summary[0]);
  expect(older.textContent).toContain(output.todos[0].text);
  expect(older.lastChild?.firstChild?.attrs.checked).toBe(false);
  expect(JSON.stringify(older.toJSON())).not.toContain("nexusOrigin");
  await store.save(location, noteId, { doc: older.toJSON() });
  expect(await summaries.undo(target)).toBe(0);
  expect((await store.read(location, noteId)).doc).toEqual(older.toJSON());
});

test("the automatic path is opt-in and short recordings do not reach Claude", async () => {
  let enabled = false;
  const runClaude = mock<NotesSummaryOptions["runClaude"]>(async () => ({ output }));
  const { summaries, store, target } = await setup({
    settings: () => ({ enabled, agent: "claude" }),
    runClaude,
  });
  expect(await summaries.summarize(target, "auto")).toBeNull();
  enabled = true;
  await store.saveTranscript(location, target.noteId, {
    version: 1,
    recordings: [{ ...recording, lines: recording.lines.slice(0, 2) }],
  });
  expect(await summaries.summarize(target, "auto")).toMatchObject({ state: "skipped" });
  expect(await summaries.summarize(target, "auto")).toBeNull();
  expect(runClaude).not.toHaveBeenCalled();
});

test("summary retention keeps active and undoable entries and still deduplicates old recordings", async () => {
  const runClaude = mock<NotesSummaryOptions["runClaude"]>(async () => ({ output }));
  const { summaries, store, target } = await setup({ runClaude });
  const { noteId, recordingId } = target;
  await summaries.states(location, noteId);
  const run = () => ({ agent: "claude" as const, runId: randomUUID(), startedAt: 1, seen: false });
  const running = "r000000001a";
  const undoable = "r000000001b";
  await store.editSummary(location, noteId, running, async () => ({
    next: { ...run(), state: "running" },
  }));
  await store.editSummary(location, noteId, undoable, async () => ({
    next: { ...run(), state: "done", endedAt: 2, todos: 1 },
  }));
  await store.editSummary(location, noteId, recordingId, async () => ({
    next: { ...run(), state: "skipped", endedAt: 3 },
  }));
  const failedId = (index: number) => `r${index.toString(36).padStart(6, "0")}012c`;
  for (let index = 0; index < 52; index++) {
    await store.editSummary(location, noteId, failedId(index), async () => ({
      next: {
        ...run(),
        state: "failed",
        endedAt: 10 + index,
        error: { kind: "failed", message: "Bearer credential" },
      },
    }));
  }
  const states = await summaries.states(location, noteId);
  expect(Object.keys(states)).toHaveLength(52);
  expect(states).toMatchObject({
    [running]: { state: "running" },
    [undoable]: { state: "done" },
    [failedId(51)]: { state: "failed", error: { message: "Bearer [redacted]" } },
  });
  expect(states[failedId(0)]).toBeUndefined();
  expect(states[recordingId]).toBeUndefined();
  expect(await summaries.summarize(target, "auto")).toBeNull();
  expect(runClaude).not.toHaveBeenCalled();
});
