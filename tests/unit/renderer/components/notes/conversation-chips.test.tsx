import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConversationChips,
  NoteConversationLinks,
  useNoteConversations,
} from "../../../../../src/renderer/components/notes/conversation-chips";
import * as noteLinks from "../../../../../src/renderer/services/notes/use-links";
import type { NoteLink } from "../../../../../src/shared/notes/links";

function LinkedWidgets() {
  return useNoteConversations().map(({ entry }) => <span key={entry.id} data-link={entry.id} />);
}

test("a task and card show one note header chip while both widget links remain available", () => {
  const link: NoteLink = {
    agent: "codex",
    kind: "task",
    workspaceId: "workspace",
    tabId: "tab",
    title: "qc-1",
    cwd: "/repo",
    session: "session",
    createdAt: 1,
    updatedAt: 2,
    result: { state: "done", at: 3, pr: { url: "https://example.com/pull/1", number: 1 } },
  };
  const links = spyOn(noteLinks, "useNoteLinks").mockReturnValue([
    { id: "l1234567", link },
    {
      id: "l1234568",
      link: { ...link, kind: "card", messageId: "answer", result: undefined, updatedAt: 4 },
    },
  ]);
  try {
    const markup = renderToStaticMarkup(
      <NoteConversationLinks
        note={{ workspaceId: "workspace", noteId: "n1234567", tabId: "note-tab" }}
        isVisible={false}
      >
        <ConversationChips />
        <LinkedWidgets />
      </NoteConversationLinks>,
    );
    expect(markup.match(/data-testid="note-conversation-chip"/g)).toHaveLength(1);
    expect(markup).toContain("Done · PR #1");
    expect(markup).toContain('data-link="l1234567"');
    expect(markup).toContain('data-link="l1234568"');
  } finally {
    links.mockRestore();
  }
});
