import { expect, spyOn, test } from "bun:test";
import { act, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConversationChip,
  ConversationChips,
  NoteCardInsertMenu,
  NoteConversationLinks,
  useNoteConversations,
} from "../../../../../src/renderer/components/notes/conversation-chips";
import * as contextMenu from "../../../../../src/renderer/components/ui/context-menu";
import * as dropdown from "../../../../../src/renderer/components/ui/dropdown-menu";
import * as toast from "../../../../../src/renderer/components/ui/toast";
import { chatKey, useChatStore } from "../../../../../src/renderer/services/chat/store";
import { notesApi } from "../../../../../src/renderer/services/notes/api";
import { noteTime } from "../../../../../src/renderer/services/notes/note-time";
import * as storedTurns from "../../../../../src/renderer/services/notes/stored-turns";
import * as noteLinks from "../../../../../src/renderer/services/notes/use-links";
import type { NoteLink } from "../../../../../src/shared/notes/links";
import { withTestDom } from "../../../../helpers/test-dom";

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

test("removing a missing conversation's header chip removes each link it stands for", async () => {
  const links = spyOn(noteLinks, "useNoteLinks").mockReturnValue([
    { id: "l1234567", link: { ...link, kind: "line" } },
    { id: "l1234568", link: { ...link, kind: "live", result: undefined, updatedAt: 4 } },
  ]);
  const pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const spies = [
    spyOn(dropdown, "DropdownMenuRoot").mockImplementation(pass),
    spyOn(dropdown, "DropdownMenuTrigger").mockImplementation(pass),
    spyOn(dropdown, "DropdownMenuContent").mockImplementation(pass),
    spyOn(dropdown, "DropdownMenuItem").mockImplementation(({ children, onSelect }) => (
      <button type="button" data-item onClick={() => onSelect?.(new Event("select"))}>
        {children}
      </button>
    )),
  ];
  const remove = spyOn(notesApi, "removeLink").mockResolvedValue(undefined);
  try {
    await withTestDom(async (host, root) => {
      await act(async () =>
        root.render(
          <NoteConversationLinks
            note={{ workspaceId: "workspace", noteId: "n1234567", tabId: "note-tab" }}
            isVisible={false}
          >
            <ConversationChips />
          </NoteConversationLinks>,
        ),
      );
      expect(host.querySelectorAll('[data-testid="note-conversation-chip"]')).toHaveLength(1);
      const unlink = Array.from(host.querySelectorAll<HTMLButtonElement>("[data-item]")).find(
        ({ textContent }) => textContent === "Remove link",
      );
      await act(async () => unlink?.click());
      expect(remove.mock.calls.map(([, , id]) => id).sort()).toEqual(["l1234567", "l1234568"]);
    });
  } finally {
    for (const spy of [links, remove, ...spies]) spy.mockRestore();
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
  expect(header.match(/<button/g)).toHaveLength(1);
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
        lastAnswer: {
          text: '<img src="bad"> [link](javascript:bad)',
          at: 1700000000000,
          turnFiles: 2,
        },
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
  expect(restored).toContain("&gt; link</p>");
  expect(restored).not.toContain("<img");
  expect(restored).not.toContain("<a ");
  expect(restored).toContain("2 files changed");
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
  expect(waiting).not.toContain("files changed");
  const running = renderToStaticMarkup(
    <ConversationChip
      {...props}
      card
      target={openTab}
      session={{ state: "running" } as NonNullable<typeof props.session>}
    />,
  );
  expect(running).not.toContain("files changed");
  const snapshot = props.entry.link.lastAnswer;
  if (!snapshot) throw new Error("Missing test snapshot");
  const zero = renderToStaticMarkup(
    <ConversationChip
      {...props}
      card
      entry={{
        ...props.entry,
        link: { ...props.entry.link, lastAnswer: { ...snapshot, turnFiles: 0 } },
      }}
    />,
  );
  expect(zero).not.toContain("files changed");
});

test("a narrow card shortens the title and keeps the status whole", () => {
  for (const session of [undefined, { state: "needsInput" } as never]) {
    const markup = renderToStaticMarkup(
      <ConversationChip
        entry={{ id: "l1234567", link: { ...link, kind: "live", result: undefined } }}
        target={openTab}
        note={{ workspaceId: link.workspaceId, tabId: "note-tab", noteId: "n1234567" }}
        session={session}
        checking={false}
        onUnavailable={() => {}}
        card
      />,
    );
    const status = /<span class="([^"]*)" data-testid="note-answer-card-status">([^<]*)</.exec(
      markup,
    );
    expect(status?.[2]).toBe(session ? "Needs you" : "Idle");
    expect(status?.[1].split(" ")).toEqual(["shrink-0", "whitespace-nowrap"]);
    expect(markup).toContain(
      `class="min-w-0 truncate font-medium text-foreground" title="${link.title}"`,
    );
  }
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

test("right-click opens the chip menu and inserts loaded or stored answers", async () => {
  const props: ComponentProps<typeof ConversationChip> = {
    entry: { id: "l1234567", link },
    target: openTab,
    note: { workspaceId: link.workspaceId, tabId: "note-tab", noteId: "n1234567" },
    session: undefined,
    checking: false,
    onUnavailable: () => {},
    header: true,
  };
  const content = spyOn(contextMenu, "ContextMenuContent").mockImplementation(({ children }) => (
    <>{children}</>
  ));
  const item = spyOn(contextMenu, "ContextMenuAction").mockReturnValue(null);
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
    await withTestDom(async (host, root) => {
      await act(async () => root.render(<ConversationChip {...props} />));
      const chip = host.querySelector('[data-testid="note-conversation-chip"]')!;
      expect(chip.getAttribute("data-state")).toBe("closed");
      await act(async () => {
        const event = document.createEvent("MouseEvent");
        event.initEvent("contextmenu", true, true);
        chip.dispatchEvent(event);
      });
      expect(chip.getAttribute("data-state")).toBe("open");
      const action = item.mock.lastCall?.[0];
      expect(action?.children).toBe("Add card to note");
      await act(async () => action?.onSelect());
      expect(stored).not.toHaveBeenCalled();
      expect(saved.mock.calls[0][3]).toEqual({ text: "Loaded answer", at: 43 });

      useChatStore.getState().remove(key);
      await act(async () => action?.onSelect());
      expect(stored).toHaveBeenCalledWith([
        "codex",
        link.workspaceId,
        link.cwd,
        null,
        link.session,
      ]);
      expect(saved.mock.calls[1][3]).toEqual({ text: "Persisted answer", at: 42 });
    });
  } finally {
    useChatStore.getState().remove(key);
    for (const spy of [content, item, stored, saved]) spy.mockRestore();
  }
});

test("the note menu lists linked conversations with their status and handles an existing card", async () => {
  const links = spyOn(noteLinks, "useNoteLinks").mockReturnValue([]);
  const sub = spyOn(dropdown, "DropdownMenuSub").mockImplementation(({ children }) => (
    <>{children}</>
  ));
  const trigger = spyOn(dropdown, "DropdownMenuSubTrigger").mockImplementation(({ children }) => (
    <button type="button">{children}</button>
  ));
  const content = spyOn(dropdown, "DropdownMenuSubContent").mockImplementation(({ children }) => (
    <>{children}</>
  ));
  const item = spyOn(dropdown, "DropdownMenuItem").mockImplementation(({ children }) => (
    <button type="button">{children}</button>
  ));
  const stored = spyOn(storedTurns, "readStoredAnswer").mockResolvedValue(undefined);
  const saved = spyOn(notesApi, "saveLiveCard").mockResolvedValue(false);
  const notify = spyOn(toast, "showToast").mockReturnValue(1);
  const render = () =>
    renderToStaticMarkup(
      <NoteConversationLinks
        note={{ workspaceId: link.workspaceId, noteId: "n1234567", tabId: "note-tab" }}
        isVisible={false}
      >
        <NoteCardInsertMenu />
      </NoteConversationLinks>,
    );
  try {
    expect(render()).toBe("");
    links.mockReturnValue([
      { id: "l1234567", link },
      { id: "l1234568", link: { ...link, kind: "live", updatedAt: 4, result: undefined } },
    ]);
    const markup = render();
    expect(markup).toContain("Add card");
    expect(markup).toContain(link.title);
    expect(markup).toContain("Done · PR #1");
    expect(item).toHaveBeenCalledTimes(1);
    expect(item.mock.lastCall?.[0].disabled).toBe(false);
    const notified = Promise.withResolvers<void>();
    notify.mockImplementation(() => {
      notified.resolve();
      return 1;
    });
    item.mock.lastCall?.[0].onSelect?.();
    await notified.promise;
    expect(notify).toHaveBeenCalledWith({
      kind: "info",
      message: "Already in note",
    });
  } finally {
    for (const spy of [links, sub, trigger, content, item, stored, saved, notify])
      spy.mockRestore();
  }
});
