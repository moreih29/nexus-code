import { expect, spyOn, test } from "bun:test";
import { notesApi } from "../../../../../src/renderer/services/notes/api";
import { sendWithNoteMentions } from "../../../../../src/renderer/services/notes/chat-link";
import { noteChoices } from "../../../../../src/renderer/services/notes/choices";
import { mentionLine, selectionPrompt } from "../../../../../src/renderer/services/notes/prompt";

test("linked notes precede the five latest other workspace notes and filter by title", () => {
  const workspace = [
    { id: "old", title: "Retro", updatedAt: 0 },
    { id: "a", title: "Release", updatedAt: 8 },
    { id: "b", title: "Review", updatedAt: 7 },
    { id: "c", title: "Follow-up", updatedAt: 6 },
    { id: "d", title: "QA", updatedAt: 5 },
    { id: "e", title: "Release 2", updatedAt: 4 },
    { id: "linked", title: "Release discussion", updatedAt: 10 },
  ];
  const linked = [{ noteId: "linked", title: "Release discussion" }];
  expect(noteChoices(linked, workspace).map(({ noteId, linked }) => [noteId, linked])).toEqual([
    ["linked", true],
    ["a", false],
    ["b", false],
    ["c", false],
    ["d", false],
    ["e", false],
  ]);
  expect(noteChoices(linked, workspace, " RELEASe ").map(({ noteId }) => noteId)).toEqual([
    "linked",
    "a",
    "e",
  ]);
  expect(noteChoices(linked, workspace, "retro")).toEqual([
    { noteId: "old", title: "Retro", linked: false },
  ]);
});

test("mentions expand after the message and create a link after the send succeeds", async () => {
  const added = spyOn(notesApi, "addLink").mockImplementation(async (_, __, link) => ({
    id: "l1234567",
    link: { ...link, createdAt: 0, updatedAt: 0 },
  }));
  const accepted = Promise.withResolvers<void>();
  const note = { noteId: "n1234567", title: "Review" };
  const target = {
    workspaceId: "ws",
    tabId: "tab",
    agent: "codex",
    cwd: "/repo",
    title: "Chat",
  } as const;
  try {
    const sending = sendWithNoteMentions("Read this", [note], target, (text) => {
      expect(text).toBe("Read this\n\nNote ‘Review’: `nexus note read n1234567`");
      return accepted.promise;
    });
    expect(added).not.toHaveBeenCalled();
    accepted.resolve();
    expect(await sending).toBe(true);
    expect(added.mock.calls).toEqual([
      ["ws", note.noteId, { ...target, kind: "mention" }, undefined],
    ]);
    await expect(
      sendWithNoteMentions("", [note], target, async () => {
        throw new Error("Send failed");
      }),
    ).rejects.toThrow("Send failed");
    expect(added).toHaveBeenCalledTimes(1);
  } finally {
    added.mockRestore();
  }
});

test("note references flatten controls and do not interpolate titles or selection text", () => {
  const note = {
    noteId: "n1234567",
    title: "Run\u202e\n{{id}} \u2066<script> ‘quoted’ `code`",
  };
  const mention = mentionLine(note);
  expect(mention).toContain("Run {{id}}  <script> ‹quoted› ˋcodeˋ");
  expect(mention).toEndWith("`nexus note read n1234567`");
  expect(mention).not.toMatch(/[\p{Cf}\n]/u);
  expect(selectionPrompt({ ...note, title: "Review" }, "One\r\n\t<scr\u202eipt>\u2028{{id}}")).toBe(
    "Take a look at this part.\n\nSelected text from the note ‘Review’:\n> One\n> \t<script>\n> {{id}}\n\nNote ‘Review’: read it with `nexus note read n1234567`.",
  );
});

test("ordinary punctuation in note titles and selected text stays readable", () => {
  const title = 'Today\'s "Q3" [WIP] release_notes';
  const note = { noteId: "n1234567", title };
  expect(mentionLine(note)).toContain(title);
  expect(selectionPrompt(note, "A *literal* line")).toContain(`‘${title}’:\n> A *literal* line`);
  const excerpt = selectionPrompt(note, `${"a".repeat(15_999)}😀tail`).split("\n")[3];
  expect(excerpt).toBe(`> ${"a".repeat(15_999)}…`);
});
