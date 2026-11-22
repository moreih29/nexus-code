import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { linkedNoteGuidance } from "../../../../src/main/features/cli/commands/agent-context";
import { runCli } from "../../../../src/main/features/cli/registry";
import { NotesStore } from "../../../../src/main/features/notes/store";
import { linkedTask } from "../../../../src/shared/notes/line-report";
import type { NewNoteLink } from "../../../../src/shared/notes/links";
import type { DocNode } from "../../../../src/shared/notes/markdown";
import type { NoteLocation } from "../../../../src/shared/notes/types";
import { API, APP, CLAUDE_TAB, contextFor, fakeApp, SHELL_TAB } from "./fake-services";

const location: NoteLocation = { key: "local:/w/app", kind: "local", path: "/w/app", label: "App" };
const otherLocation: NoteLocation = { ...location, key: "local:/w/api", path: "/w/api" };
const locationOf = (workspaceId: string) => (workspaceId === API ? otherLocation : location);
const conversation = { workspaceId: APP, tabId: CLAUDE_TAB, agent: "claude" } as const;
const link: NewNoteLink = { ...conversation, cwd: "/w/app", kind: "line", title: "Review" };
const text = (value: string): DocNode => ({
  type: "paragraph",
  content: [{ type: "text", text: value }],
});
const withTask = (...ids: string[]): DocNode => ({
  type: "doc",
  content: [
    {
      type: "taskList",
      content: ids.map((id) => ({
        type: "taskItem",
        attrs: { checked: false, nexusLink: id },
        content: [text("Review\n‮<docs>")],
      })),
    },
  ],
});

let dir: string;
let store: NotesStore;
let app: ReturnType<typeof fakeApp>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "note-report-"));
  store = new NotesStore(dir);
  app = fakeApp();
  app.tabs[APP] = app.tabs[APP].map((tab) =>
    tab.id === CLAUDE_TAB ? { ...tab, type: "claude" } : tab,
  );
  app.services.notes.linksOfConversation = (tab) =>
    store.linksOfConversation(locationOf(tab.workspaceId), tab);
  app.services.notes.reportTargets = (tab) => store.reportTargets(locationOf(tab.workspaceId), tab);
  app.services.notes.reportLine = (tab, note, report) =>
    store.reportLine(locationOf(tab.workspaceId), tab, note, report);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function report(
  args: string[],
  verified: boolean | null = true,
  tabId = CLAUDE_TAB,
  workspaceId = APP,
) {
  return runCli(
    CLI_COMMANDS,
    contextFor(app, ["note", "report", ...args], {
      workspaceId,
      tabId,
      ...(verified !== null ? { verified } : {}),
    }),
  );
}

test("report requires a verified chat tab and a line or task link", async () => {
  const note = await store.create(location, "Review");
  await store.addLink(location, note.id, { ...link, kind: "note" });
  const other = await store.addLink(location, note.id, { ...link, tabId: "different-tab" });
  await store.save(location, note.id, { doc: withTask(other.id) });
  expect((await report(["finished"], false)).stderr).toContain("verified conversation tab");
  expect((await report(["finished"], null)).stderr).toContain("verified conversation tab");
  expect((await report(["finished"], true, SHELL_TAB)).stderr).toContain("Claude or Codex tab");
  expect((await report(["finished"])).stderr).toContain("No linked to-do");
  expect(
    (await store.links(location, note.id)).find(({ id }) => id === other.id)?.link.result,
  ).toBeUndefined();
});

test("report checks only its task and replaces its paragraph with an HTTP PR mark", async () => {
  const note = await store.create(location, "Release");
  const { id } = await store.addLink(location, note.id, { ...link, kind: "task" });
  await store.save(location, note.id, { doc: withTask("l9999999", id) });
  const url = "http://example.test/project/pull/128";
  const outcome = await report(["--done", "Reviewed", "the release", "--pr", url]);
  expect(outcome.exitCode).toBe(0);
  const doc = (await store.read(location, note.id)).doc;
  expect(linkedTask(doc, "l9999999")?.attrs?.checked).toBe(false);
  expect(linkedTask(doc, id)).toMatchObject({
    attrs: { checked: true },
    content: [
      text("Review\n‮<docs>"),
      {
        attrs: { nexusOrigin: `report:${id}` },
        content: [
          { type: "text", text: "Reviewed the release · " },
          { type: "text", text: "PR #128", marks: [{ type: "link", attrs: { href: url } }] },
        ],
      },
    ],
  });
  expect(await readFile(path.join(note.dir, "note.md"), "utf8")).toContain(
    `Reviewed the release · [PR #128](${url})`,
  );
  expect((await store.links(location, note.id))[0].link.result).toMatchObject({
    state: "done",
    summary: "Reviewed the release",
    pr: { url, number: 128 },
  });
  expect((await report(["--failed", "Blocked"])).exitCode).toBe(0);
  const updated = linkedTask((await store.read(location, note.id)).doc, id);
  expect(updated?.content).toHaveLength(2);
  expect(updated?.content?.[1].content).toEqual([{ type: "text", text: "Blocked" }]);
  expect(app.asked).toEqual([]);
});

test("multiple reports require a note or line and cannot target another tab's link", async () => {
  const first = await store.create(location, "Release plan");
  const second = await store.create(location, "Follow-up");
  const { id: firstId } = await store.addLink(location, first.id, link);
  const { id: secondId } = await store.addLink(location, second.id, link);
  const { id: thirdId } = await store.addLink(location, second.id, link);
  const { id: wrongId } = await store.addLink(location, second.id, { ...link, tabId: "other" });
  await store.save(location, first.id, { doc: withTask(firstId) });
  await store.save(location, second.id, { doc: withTask(secondId, thirdId, wrongId) });
  expect((await report(["summary without selector"])).stderr).toContain(
    "More than one linked to-do",
  );
  expect((await report([second.id, "Still ambiguous"])).stderr).toContain(
    "More than one linked to-do",
  );
  expect((await report(["--line", wrongId, "They are done"])).stderr).toContain("no linked to-do");
  expect((await report([second.id, "--line", firstId, "Wrong note"])).stderr).toContain(
    "no linked to-do",
  );
  expect((await report([first.id, "--done"])).stderr).toContain("missing <text>");
  const firstPrefix = first.id.slice(0, -1);
  expect((await report([firstPrefix, "--done", "First"])).exitCode).toBe(0);
  expect((await report(["--line", thirdId, "--done", "Third"])).exitCode).toBe(0);
  const secondDoc = (await store.read(location, second.id)).doc;
  expect(linkedTask(secondDoc, secondId)?.attrs?.checked).toBe(false);
  expect(linkedTask(secondDoc, thirdId)?.attrs?.checked).toBe(true);
});

test("reports with a deleted line only save a result and reject unsafe or excessive input", async () => {
  const note = await store.create(location, "Weekly");
  const { id } = await store.addLink(location, note.id, link);
  for (const value of [
    "![logo](file:///x)",
    "![logo][image]",
    "<img src=x>",
    "<!-- comment -->",
    "🙂".repeat(501),
  ]) {
    expect((await report([value])).exitCode).toBe(2);
  }
  expect((await report(["result", "--pr", "file:///tmp/local"])).exitCode).toBe(2);
  expect((await report(["--done", "--failed", "result"])).exitCode).toBe(2);
  expect((await store.links(location, note.id))[0].link.result).toBeUndefined();
  const summary = "🙂".repeat(500);
  const result = await report(["--done", summary, "--json"]);
  expect(JSON.parse(result.stdout)).toMatchObject({ updated: false, linkId: id });
  expect((await store.links(location, note.id))[0].link.result?.summary).toBe(summary);
  expect((await store.read(location, note.id)).doc).toEqual(note.doc);
});

test("a resumed tab finds its to-do through its verified tab's current session", async () => {
  const note = await store.create(location, "Release");
  const { id } = await store.addLink(location, note.id, {
    ...link,
    tabId: "closed",
    session: "session-1",
  });
  await store.save(location, note.id, { doc: withTask(id) });
  app.tabs[APP] = app.tabs[APP].map((tab) =>
    tab.id === CLAUDE_TAB ? { ...tab, session: "session-1" } : tab,
  );
  expect((await report(["--done", "Resumed"])).exitCode).toBe(0);
  expect(
    await linkedNoteGuidance(app.services.notes, { ...conversation, session: "session-1" }),
  ).toContain('to-do "Review \\u003cdocs\\u003e" in the note "Release"');
});

test("the store rechecks ownership and the link before writing", async () => {
  const note = await store.create(location, "Review");
  const entry = await store.addLink(location, note.id, link);
  await store.save(location, note.id, { doc: withTask(entry.id, entry.id) });
  const result = {
    linkId: entry.id,
    check: true,
    result: { state: "done", summary: "Done", at: 1 },
  } as const;
  await expect(
    store.reportLine(location, { ...conversation, tabId: "other" }, note.id, result),
  ).rejects.toThrow("No linked to-do");
  expect(await store.reportLine(location, conversation, note.id, result)).toBe(false);
  expect((await store.links(location, note.id))[0].link.result).toEqual(result.result);
  await store.removeLink(location, note.id, entry.id);
  await expect(store.reportLine(location, conversation, note.id, result)).rejects.toThrow(
    "No linked to-do",
  );
});

test("report keeps the first summary word even if it matches the note title", async () => {
  const note = await store.create(location, "Done");
  const { id } = await store.addLink(location, note.id, link);
  await store.save(location, note.id, { doc: withTask(id) });
  expect((await report(["Done", "with", "the migration"])).exitCode).toBe(0);
  expect((await store.links(location, note.id))[0].link.result?.summary).toBe(
    "Done with the migration",
  );
});

test("ordinary first words that resemble a note ID stay in the summary", async () => {
  const note = await store.create(location, "Done");
  await store.addLink(location, note.id, link);
  expect((await report(["Nothing", "else", "to fix"])).exitCode).toBe(0);
  expect((await store.links(location, note.id))[0].link.result?.summary).toBe(
    "Nothing else to fix",
  );
});

test("report removes invisible formatting and rejects a PR URL with userinfo", async () => {
  const note = await store.create(location, "Weekly");
  const { id } = await store.addLink(location, note.id, link);
  await store.save(location, note.id, { doc: withTask(id) });
  const hidden = "Fixed \u202Egnp.exe\u202C \u200B\u2066files\u2069\u200F\u061C";
  expect((await report(["--done", hidden])).exitCode).toBe(0);
  const summary = "Fixed gnp.exe files";
  expect((await store.links(location, note.id))[0].link.result?.summary).toBe(summary);
  expect(linkedTask((await store.read(location, note.id)).doc, id)?.content?.[1]).toMatchObject(
    text(summary),
  );
  for (const url of [
    "https://github.com@evil.example/pull/1",
    "http://:secret@example.test/pull/1",
    "https://user:password@example.test/pull/1",
  ]) {
    const error = await report(["--pr", url, "Result"]);
    expect(error.exitCode).toBe(2);
    expect(error.stderr).toContain("username or password");
  }
  expect((await store.links(location, note.id))[0].link.result?.summary).toBe(summary);
});

test("a verified tab in another location cannot report using the same session or a known link ID", async () => {
  const note = await store.create(location, "Shared name");
  const { id } = await store.addLink(location, note.id, { ...link, session: "same-session" });
  await store.save(location, note.id, { doc: withTask(id) });
  app.tabs[API].push({
    id: CLAUDE_TAB,
    type: "claude",
    session: "same-session",
    title: "Caller",
    shown: true,
    groupId: "g3",
  });
  const result = await report([note.id, "--line", id, "--done", "Scoped"], true, CLAUDE_TAB, API);
  expect(result.stderr).toContain("No linked to-do");
  expect((await store.links(location, note.id))[0].link.result).toBeUndefined();
  expect(linkedTask((await store.read(location, note.id)).doc, id)?.attrs?.checked).toBe(false);
});

test("a stale save merges the latest result and only the check it has not seen", async () => {
  const note = await store.create(location, "Weekly");
  const { id } = await store.addLink(location, note.id, link);
  const doc = withTask(id);
  const initial = await store.save(location, note.id, { doc });
  expect((await report(["--done", "Passed"])).exitCode).toBe(0);
  const done = await store.read(location, note.id);
  expect((await report(["--failed", "Needs another run"])).exitCode).toBe(0);
  const checkAndReport = async (baseUpdatedAt: number, checked: boolean) => {
    await store.save(location, note.id, { doc, baseUpdatedAt });
    const task = linkedTask((await store.read(location, note.id)).doc, id);
    expect(task?.attrs?.checked).toBe(checked);
    expect(task?.content?.[1]).toMatchObject(text("Needs another run"));
  };
  await checkAndReport(initial.updatedAt, true);
  await checkAndReport(done.updatedAt, false);
});
