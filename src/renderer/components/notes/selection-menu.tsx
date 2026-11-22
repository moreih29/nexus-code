import { TextSelection } from "@tiptap/pm/state";
import { type Editor, useEditorState } from "@tiptap/react";
import { BubbleMenu, type BubbleMenuProps } from "@tiptap/react/menus";
import { Bold, Bot, ChevronDown, Italic, Link } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { safeNoteUrl } from "../../../shared/notes/answer-card";
import { conversationStatus, conversationTitle } from "../../services/notes/conversation";
import { sendNoteSelection } from "../../services/notes/send-selection";
import { ClaudeIcon, CodexIcon } from "../chat/agent-icons";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { IconButton } from "../ui/icon-button";
import { PromptDialog } from "../ui/prompt-dialog";
import { showToast } from "../ui/toast";
import { useNoteConversations } from "./conversation-chips";

const MENU_OPTIONS: BubbleMenuProps["options"] = {
  placement: "top",
  offset: 6,
  flip: true,
  shift: { padding: 8 },
  hide: true,
};

function textSelected(editor: Editor): string {
  const { doc, selection } = editor.state;
  if (!(selection instanceof TextSelection) || selection.empty) return "";
  const text = doc.textBetween(selection.from, selection.to, "\n", (node) =>
    node.type.name === "hardBreak" ? "\n" : "",
  );
  return text.trim() ? text : "";
}

export function NoteSelectionMenu({
  editor,
  workspaceId,
  cwd,
  noteId,
  title,
  flush,
}: {
  editor: Editor;
  workspaceId: string;
  cwd: string;
  noteId: string;
  title: () => string;
  flush: () => Promise<boolean>;
}) {
  const { t, i18n } = useTranslation("notes");
  const [linkDialog, setLinkDialog] = useState<{ href: string }>();
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const excerpt = useRef("");
  const dropdownOpen = useRef(false);
  const showMenu = useCallback<NonNullable<BubbleMenuProps["shouldShow"]>>(
    ({ editor: current, element, view }) =>
      current.isEditable &&
      Boolean(textSelected(current)) &&
      (view.hasFocus() || element.contains(document.activeElement) || dropdownOpen.current),
    [],
  );
  const rows = useNoteConversations();
  const marks = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      link: current.isActive("link"),
    }),
  });
  const seen = new Set<string>();
  const destinations = rows.flatMap(({ entry, target, session }) => {
    if (target.kind !== "open" && target.kind !== "moved") return [];
    const key = `${target.workspace.id}:${target.tab.id}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ key, entry, target, session }];
  });

  const send = async (destination: Parameters<typeof sendNoteSelection>[2]) => {
    const selected = excerpt.current;
    if (!selected || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      if (!(await flush())) {
        showToast({ kind: "error", message: t("conversations.noteSaveError") });
        return;
      }
      const outcome = await sendNoteSelection(
        { workspaceId, noteId, title: title() },
        selected,
        destination,
      );
      if (outcome.queued) showToast({ kind: "info", message: t("agent.sentQueued") });
      if (!outcome.linked) showToast({ kind: "error", message: t("conversations.saveError") });
    } catch {
      showToast({ kind: "error", message: t("agent.sendError") });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  return (
    <>
      <BubbleMenu
        editor={editor}
        pluginKey="noteSelection"
        options={MENU_OPTIONS}
        shouldShow={showMenu}
        className="z-(--layer-floating) flex items-center gap-0.5 rounded-(--radius-control) border border-border bg-popover p-0.5"
        data-testid="note-selection-menu"
      >
        <IconButton
          label={t("connections.bold")}
          aria-pressed={marks.bold}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold className="size-3.5" aria-hidden="true" />
        </IconButton>
        <IconButton
          label={t("connections.italic")}
          aria-pressed={marks.italic}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic className="size-3.5" aria-hidden="true" />
        </IconButton>
        <IconButton
          label={t("connections.link")}
          aria-pressed={marks.link}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setLinkDialog({ href: editor.getAttributes("link").href ?? "" })}
        >
          <Link className="size-3.5" aria-hidden="true" />
        </IconButton>
        <DropdownMenuRoot
          onOpenChange={(open) => {
            dropdownOpen.current = open;
            if (open) excerpt.current = textSelected(editor);
          }}
        >
          <DropdownMenuTrigger>
            <button
              type="button"
              disabled={sending}
              className="flex h-6 shrink-0 items-center gap-1 rounded-(--radius-control) px-1.5 text-app-ui-sm text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground"
              data-testid="note-selection-send"
            >
              <Bot className="size-3.5" aria-hidden="true" />
              {t("editor.toAgent")}
              <ChevronDown className="size-3" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>{t("connections.sendSelection")}</DropdownMenuLabel>
            {destinations.map(({ key, entry, target, session }) => {
              const { workspace, tab } = target;
              const { agent } = entry.link;
              const Icon = agent === "claude" ? ClaudeIcon : CodexIcon;
              const status = conversationStatus(target, session, entry.link.result);
              const time = session?.limitWait
                ? new Intl.DateTimeFormat(i18n.language || undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                  }).format(session.limitWait.at)
                : "";
              return (
                <DropdownMenuItem
                  key={key}
                  onSelect={() =>
                    void send({ agent, workspaceId: workspace.id, tabId: tab.id, linkId: entry.id })
                  }
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="max-w-48 truncate">
                      {conversationTitle(entry.link.title, target) || t(`conversations.${agent}`)}
                    </span>
                  </span>
                  <span className="ml-2 shrink-0 text-app-micro text-muted-foreground">
                    {t(`conversations.${status}`, { time })}
                  </span>
                </DropdownMenuItem>
              );
            })}
            {destinations.length > 0 && <DropdownMenuSeparator />}
            {(["claude", "codex"] as const).map((agent) => {
              const Icon = agent === "claude" ? ClaudeIcon : CodexIcon;
              return (
                <DropdownMenuItem
                  key={agent}
                  disabled={!cwd}
                  onSelect={() => void send({ agent, cwd })}
                >
                  <span className="flex items-center gap-1.5">
                    <Icon className="size-3.5" aria-hidden="true" />
                    {t(`agent.${agent}`)}
                  </span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenuRoot>
      </BubbleMenu>
      <PromptDialog
        request={
          linkDialog
            ? {
                title: t("connections.link"),
                label: t("connections.linkUrl"),
                defaultValue: linkDialog.href,
                placeholder: "https://",
                allowEmpty: Boolean(linkDialog.href),
              }
            : null
        }
        onCancel={() => setLinkDialog(undefined)}
        onConfirm={(value) => {
          const href = safeNoteUrl(value);
          if (value && !href) {
            showToast({ kind: "error", message: t("connections.linkInvalid") });
            return;
          }
          const chain = editor.chain().focus();
          (href ? chain.setLink({ href }) : chain.unsetLink()).run();
          setLinkDialog(undefined);
        }}
      />
    </>
  );
}
