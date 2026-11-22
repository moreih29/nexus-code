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
  expect(noteChoices(linked, workspace, "retro")).toEqual([]);
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
    title: "Run\u202e\n{{id}} \u2066<script> `no` [x](javascript:bad)",
  };
  const mention = mentionLine(note);
  expect(mention).toContain(
    String.raw`Run \u007b\u007bid\u007d\u007d  \u003cscript\u003e \u0060no\u0060 \u005bx\u005d`,
  );
  expect(mention).toEndWith("`nexus note read n1234567`");
  expect(mention).not.toMatch(/[\p{Cf}\n]/u);
  expect(selectionPrompt({ ...note, title: "Review" }, "One\n<script>\n{{id}}")).toBe(
    "Take a look at this part.\n\nSelected text from the note ‘Review’:\n> One\n> \\<script\\>\n> {{id}}\n\nNote ‘Review’: read it with `nexus note read n1234567`.",
  );
});
