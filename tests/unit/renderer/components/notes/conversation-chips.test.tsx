import { expect, spyOn, test } from "bun:test";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConversationChip,
  ConversationChips,
  NoteConversationLinks,
  useNoteConversations,
} from "../../../../../src/renderer/components/notes/conversation-chips";
import * as noteLinks from "../../../../../src/renderer/services/notes/use-links";
import type { NoteLink } from "../../../../../src/shared/notes/links";

function LinkedWidgets() {
  return useNoteConversations().map(({ entry }) => <span key={entry.id} data-link={entry.id} />);
}

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

test("a task and card show one note header chip while both widget links remain available", () => {
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

test("a restored open tab gives the note header quiet completion and the task chip its saved PR", () => {
  const props: ComponentProps<typeof ConversationChip> = {
    entry: { id: "l1234567", link },
    target: {
      kind: "open",
      workspace: { id: link.workspaceId } as never,
      tab: {
        id: link.tabId,
        type: "codex",
        title: link.title,
        defaultTitle: "Codex",
        isPinned: false,
        isPreview: false,
        props: { cwd: link.cwd, threadId: link.session },
      },
    },
    note: { workspaceId: link.workspaceId, tabId: "note-tab", noteId: "n1234567" },
    session: undefined,
    hasStoredTurns: true,
    checking: false,
    onUnavailable: () => {},
  };
  const header = renderToStaticMarkup(<ConversationChip {...props} />);
  expect(header).toContain(" · Done");
  expect(header).not.toContain("PR #1");
  const line = renderToStaticMarkup(<ConversationChip {...props} line />);
  expect(line).toContain("Done · PR #1");
});

test("live cards show saved answers as text and offer to answer an active question", () => {
  const props: ComponentProps<typeof ConversationChip> = {
    entry: {
      id: "l1234567",
      link: {
        ...link,
        kind: "live",
        result: undefined,
        lastAnswer: { text: '<img src="bad"> [link](javascript:bad)', at: 1700000000000, files: 2 },
      },
    },
    target: { kind: "missing" },
    note: { workspaceId: link.workspaceId, tabId: "note-tab", noteId: "n1234567" },
    session: undefined,
    checking: false,
    onUnavailable: () => {},
  };
  const restored = renderToStaticMarkup(<ConversationChip {...props} card />);
  expect(restored).toContain("&lt;img");
  expect(restored).not.toContain("<img");
  expect(restored).not.toContain("<a ");
  expect(restored).toContain("2 files");
  expect(restored).not.toContain("Answer in conversation");
  const waiting = renderToStaticMarkup(
    <ConversationChip
      {...props}
      card
      target={{
        kind: "open",
        workspace: { id: link.workspaceId } as never,
        tab: {
          id: link.tabId,
          type: "codex",
          title: link.title,
          defaultTitle: "Codex",
          isPinned: false,
          isPreview: false,
          props: { cwd: link.cwd, threadId: link.session },
        },
      }}
      session={{ state: "needsInput" } as NonNullable<typeof props.session>}
    />,
  );
  expect(waiting).toContain("1 question · Answer in conversation");
});
