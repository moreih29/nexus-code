import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NotesStore } from "../../../../../src/main/features/notes/store";
import {
  MAX_NOTE_LINK_BYTES,
  MAX_NOTE_LINKS,
  type NewNoteLink,
} from "../../../../../src/shared/notes/links";
import type { NoteLocation } from "../../../../../src/shared/notes/types";

const location: NoteLocation = {
  key: "local:/workspace",
  kind: "local",
  path: "/workspace",
  label: "Workspace",
};
const base: NewNoteLink = {
  agent: "claude",
  workspaceId: "123e4567-e89b-12d3-a456-426614174000",
  tabId: "tab-1",
  cwd: "/workspace",
  title: "Conversation",
  kind: "note",
};

let root: string;
let store: NotesStore;
let note: Awaited<ReturnType<NotesStore["create"]>>;
let file: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "note-links-"));
  store = new NotesStore(root);
  note = await store.create(location, "Note");
  file = path.join(note.dir, "links.json");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a note without links opens with an empty list and does not get a link file", async () => {
  expect(await store.links(location, note.id)).toEqual([]);
  await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
});

test("broken, unrecognized and oversized link files read as empty", async () => {
  for (const content of [
    "{incomplete",
    '{"version":2,"conversations":{}}',
    " ".repeat(MAX_NOTE_LINK_BYTES + 1),
  ]) {
    await writeFile(file, content);
    expect(await store.links(location, note.id)).toEqual([]);
  }
  const entry = await store.addLink(location, note.id, base);
  expect(await store.links(location, note.id)).toEqual([entry]);
});

test("loose decoding keeps valid entries beside malformed ones", async () => {
  const valid = { ...base, createdAt: 1, updatedAt: 1 };
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      conversations: {
        l1234567: { ...valid, extra: true },
        l1234568: { ...valid, agent: "unknown" },
        invalid: valid,
      },
    }),
  );
  expect(await store.links(location, note.id)).toEqual([{ id: "l1234567", link: valid }]);
});

test("concurrent writes preserve each link, session order and the previous-session cap", async () => {
  const [first, second] = await Promise.all([
    store.addLink(location, note.id, { ...base, session: "s0" }),
    store.addLink(location, note.id, { ...base, tabId: "tab-2" }),
  ]);
  const changes: string[] = [];
  await Promise.all(
    Array.from({ length: 7 }, (_, index) =>
      store.updateLinksForTab(location, { ...base, session: `s${index + 1}` }, (id) =>
        changes.push(id),
      ),
    ),
  );
  const links = await store.links(location, note.id);
  expect(links).toEqual([
    {
      id: first.id,
      link: expect.objectContaining({ session: "s7", sessions: ["s6", "s5", "s4", "s3", "s2"] }),
    },
    second,
  ]);
  expect(changes).toEqual(Array(7).fill(note.id));
  await Promise.all([
    store.updateLink(location, note.id, first.id, { session: "s5" }),
    store.removeLink(location, note.id, second.id),
  ]);
  expect(await store.links(location, note.id)).toEqual([
    {
      id: first.id,
      link: expect.objectContaining({ session: "s5", sessions: ["s7", "s6", "s4", "s3", "s2"] }),
    },
  ]);
});

test("the reverse index loads existing links and reads only linked notes after warming", async () => {
  const unrelated = await store.create(location, "Unrelated");
  const entry = await store.addLink(location, note.id, { ...base, session: "before" });
  await store.addLink(location, unrelated.id, { ...base, tabId: "unrelated" });
  const reopened = new NotesStore(root);
  expect(await reopened.linksOfConversation(location, base)).toEqual([
    { noteId: note.id, title: "Note", updatedAt: entry.link.updatedAt },
  ]);

  const open = spyOn(fs, "open");
  const read = spyOn(fs, "readFile");
  try {
    const unknown = { ...base, tabId: "unknown", session: "unknown" };
    await reopened.updateLinksForTab(location, unknown, () => {});
    expect(await reopened.linksOfConversation(location, unknown)).toEqual([]);
    expect(open).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();

    const changed: string[] = [];
    await reopened.updateLinksForTab(location, { ...base, session: "after" }, (id) =>
      changed.push(id),
    );
    expect(changed).toEqual([note.id]);
    expect(open.mock.calls.filter(([, flags]) => flags === "r").map(([file]) => file)).toEqual([
      path.join(note.dir, "links.json"),
    ]);
    for (const session of ["before", "after"]) {
      expect(await reopened.linksOfConversation(location, { ...unknown, session })).toEqual([
        expect.objectContaining({ noteId: note.id }),
      ]);
    }
  } finally {
    open.mockRestore();
    read.mockRestore();
  }
});

test("changes, deletions, and removing a location keep its reverse index current", async () => {
  const other = await store.create(location, "Newer link");
  const previous = { ...base, session: "previous" };
  const [empty, first] = await Promise.all([
    store.linksOfConversation(location, previous),
    store.addLink(location, note.id, previous),
  ]);
  expect(empty).toEqual([]);
  const second = await store.addLink(location, other.id, previous);
  const touched = await store.addLink(location, other.id, { ...previous, title: "Ignored" }, true);
  expect(touched).toEqual({
    id: second.id,
    link: { ...second.link, updatedAt: touched.link.updatedAt },
  });
  expect(touched.link.updatedAt).toBeGreaterThan(second.link.updatedAt);
  expect((await store.linksOfConversation(location, previous)).map(({ noteId }) => noteId)).toEqual(
    [other.id, note.id],
  );

  const moved = { ...base, tabId: "moved", session: "current" };
  await store.updateLink(location, note.id, first.id, moved);
  await store.remove(location, other.id);
  expect(await store.linksOfConversation(location, moved)).toHaveLength(1);
  expect(await store.linksOfConversation(location, base)).toEqual([]);
  await store.removeLink(location, note.id, first.id);
  expect(await store.linksOfConversation(location, moved)).toEqual([]);

  await store.removeLocation(location.key);
  const recreated = new NotesStore(root);
  const restored = await recreated.create(location, "Restored");
  await recreated.addLink(location, restored.id, base);
  expect(await store.linksOfConversation(location, base)).toEqual([
    expect.objectContaining({ noteId: restored.id }),
  ]);
});

test("the conversation cap leaves the file unchanged and space can be reclaimed", async () => {
  const full = Object.fromEntries(
    Array.from({ length: MAX_NOTE_LINKS }, (_, i) => [
      `l${String(i).padStart(7, "0")}`,
      { ...base, createdAt: i, updatedAt: i },
    ]),
  );
  const content = JSON.stringify({ version: 1, conversations: full });
  await writeFile(file, content);
  await expect(store.addLink(location, note.id, base)).rejects.toMatchObject({
    code: "bad-request",
  });
  expect(await readFile(file, "utf8")).toBe(content);
  await store.removeLink(location, note.id, "l0000000");
  await store.addLink(location, note.id, base);
  expect(await store.links(location, note.id)).toHaveLength(MAX_NOTE_LINKS);
});

test("the byte cap uses UTF-8 and rejects oversized edits atomically", async () => {
  const large: NewNoteLink = { ...base, cwd: `/${"길".repeat(4000)}`, title: "제".repeat(200) };
  const almostFull = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [
      `l${String(i).padStart(7, "0")}`,
      { ...large, createdAt: i, updatedAt: i },
    ]),
  );
  const content = JSON.stringify({ version: 1, conversations: almostFull });
  await writeFile(file, content);
  await expect(store.addLink(location, note.id, large)).rejects.toMatchObject({
    code: "bad-request",
  });
  expect(await readFile(file, "utf8")).toBe(content);
});

test("links count toward text storage and leave the note document and sort date intact", async () => {
  const textBefore = (await store.storage())[0].bytes.text;
  const previous = await readFile(path.join(note.dir, "note.json"), "utf8");
  const markdown = await readFile(path.join(note.dir, "note.md"), "utf8");
  await store.addLink(location, note.id, base);
  expect((await store.storage())[0].bytes.text).toBe(textBefore + (await stat(file)).size);
  expect(await readFile(path.join(note.dir, "note.json"), "utf8")).toBe(previous);
  expect(await readFile(path.join(note.dir, "note.md"), "utf8")).toBe(markdown);
  expect((await store.list(location))[0].updatedAt).toBe(note.updatedAt);
  await store.save(location, note.id, { title: "Updated" });
  expect(await store.links(location, note.id)).toHaveLength(1);
  await store.remove(location, note.id);
  expect(await store.links(location, note.id)).toEqual([]);
  await expect(store.addLink(location, note.id, base)).rejects.toMatchObject({ code: "not-found" });
});

test("the conversation header receives one note for its task and card links", async () => {
  const chat = { ...base, session: "session" };
  const task = await store.addLink(location, note.id, { ...chat, kind: "task" });
  const paragraph = (text: string) => ({
    type: "paragraph",
    content: [{ type: "text", text }],
  });
  await store.save(location, note.id, {
    doc: {
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { nexusLink: task.id },
              content: [paragraph("Run the checks")],
            },
          ],
        },
      ],
    },
  });
  await store.saveAnswer(
    location,
    note.id,
    { ...chat, messageId: "answer" },
    [paragraph("Checks passed")],
    () => {},
  );
  const entries = await store.links(location, note.id);
  expect(entries.map(({ link }) => link.kind)).toEqual(["task", "card"]);
  const expected = [
    {
      noteId: note.id,
      title: note.title,
      line: "Run the checks",
      updatedAt: Math.max(...entries.map(({ link }) => link.updatedAt)),
    },
  ];
  expect(await store.linksOfConversation(location, chat)).toEqual(expected);
  expect(await store.linksOfConversation(location, { ...chat, tabId: "reopened" })).toEqual(
    expected,
  );
});
