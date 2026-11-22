import { expect, spyOn, test } from "bun:test";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConversationChip,
  ConversationChips,
  NoteConversationLinks,
  useNoteConversations,
} from "../../../../../src/renderer/components/notes/conversation-chips";
import * as dropdown from "../../../../../src/renderer/components/ui/dropdown-menu";
import { chatKey, useChatStore } from "../../../../../src/renderer/services/chat/store";
import { notesApi } from "../../../../../src/renderer/services/notes/api";
import { noteTime } from "../../../../../src/renderer/services/notes/note-time";
import * as storedTurns from "../../../../../src/renderer/services/notes/stored-turns";
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

const openTab: ComponentProps<typeof ConversationChip>["target"] = {
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
    target: openTab,
    note: { workspaceId: link.workspaceId, tabId: "note-tab", noteId: "n1234567" },
    session: undefined,
    hasStoredTurns: true,
    checking: false,
    onUnavailable: () => {},
  };
  const header = renderToStaticMarkup(<ConversationChip {...props} header />);
  expect(header).toContain(" · Done");
  expect(header).not.toContain("PR #1");
  const menu = header.match(/<button[^>]*aria-label="Conversation menu"[^>]*>/)?.[0];
  expect(menu).toContain("absolute end-0");
  expect(menu).toContain("opacity-0");
  expect(menu).toContain("group-hover:opacity-100");
  expect(menu).toContain("group-focus-within:opacity-100");
  expect(menu).not.toContain('tabindex="-1"');
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
      target={openTab}
      session={{ state: "needsInput" } as NonNullable<typeof props.session>}
    />,
  );
  expect(waiting).toContain("1 question · Answer in conversation");
});

test("the card uses the notes list's timestamp for today's time and earlier dates", () => {
  const today = new Date(2026, 10, 22, 16, 46).getTime();
  const earlier = new Date(2026, 10, 14, 16, 46).getTime();
  const now = spyOn(Date, "now").mockReturnValue(today);
  try {
    for (const at of [today, earlier]) {
      const markup = renderToStaticMarkup(
        <ConversationChip
          entry={{
            id: "l1234567",
            link: { ...link, kind: "live", lastAnswer: { text: "Answer", at } },
          }}
          target={openTab}
          note={{ workspaceId: link.workspaceId, tabId: "note-tab", noteId: "n1234567" }}
          session={undefined}
          checking={false}
          onUnavailable={() => {}}
          card
        />,
      );
      expect(markup).toContain(`· ${noteTime(at)}`);
    }
  } finally {
    now.mockRestore();
  }
});

test("the insert action saves the loaded answer first and falls back to the stored preview", async () => {
  const props: ComponentProps<typeof ConversationChip> = {
    entry: { id: "l1234567", link },
    target: openTab,
    note: { workspaceId: link.workspaceId, tabId: "note-tab", noteId: "n1234567" },
    session: undefined,
    checking: false,
    onUnavailable: () => {},
    header: true,
  };
  const root = spyOn(dropdown, "DropdownMenuRoot").mockImplementation(({ children }) => (
    <>{children}</>
  ));
  const trigger = spyOn(dropdown, "DropdownMenuTrigger").mockImplementation(({ children }) => (
    <>{children}</>
  ));
  const content = spyOn(dropdown, "DropdownMenuContent").mockImplementation(({ children }) => (
    <>{children}</>
  ));
  const item = spyOn(dropdown, "DropdownMenuItem").mockReturnValue(null);
  const stored = spyOn(storedTurns, "readStoredAnswer").mockResolvedValue({
    text: "Persisted answer",
    at: 42,
  });
  const saved = spyOn(notesApi, "saveLiveCard").mockResolvedValue(true);
  const key = chatKey(link.workspaceId, link.tabId);
  try {
    useChatStore.getState().update(key, (state) => ({
      ...state,
      model: {
        ...state.model,
        items: [
          {
            kind: "assistant",
            key: "latest",
            messageId: "latest",
            at: 43,
            blocks: [{ type: "text", text: "Loaded answer" }],
          },
        ],
      },
    }));
    renderToStaticMarkup(<ConversationChip {...props} />);
    item.mock.calls[0][0].onSelect?.();
    expect(stored).not.toHaveBeenCalled();
    expect(saved.mock.calls[0][3]).toEqual({ text: "Loaded answer", at: 43 });

    useChatStore.getState().remove(key);
    const finished = Promise.withResolvers<void>();
    saved.mockImplementation(async () => {
      finished.resolve();
      return true;
    });
    item.mock.calls[0][0].onSelect?.();
    await finished.promise;
    expect(stored).toHaveBeenCalledWith(["codex", link.workspaceId, link.cwd, null, link.session]);
    expect(saved.mock.calls[1][3]).toEqual({ text: "Persisted answer", at: 42 });
  } finally {
    useChatStore.getState().remove(key);
    for (const spy of [root, trigger, content, item, stored, saved]) spy.mockRestore();
  }
});
