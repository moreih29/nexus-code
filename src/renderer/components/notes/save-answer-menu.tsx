import { NotebookPen, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { notesApi } from "../../services/notes/api";
import { chatNoteTarget, syncChatNoteLink } from "../../services/notes/chat-link";
import { useChatNotes, useRecentChatNotes } from "../../services/notes/chat-notes";
import { noteChoices } from "../../services/notes/choices";
import { openConversationNote } from "../../services/notes/open-conversation-note";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { IconButton } from "../ui/icon-button";
import { showToast } from "../ui/toast";

export function SaveAnswerMenu({
  claudeUuid,
  messageId,
  markdown,
}: {
  claudeUuid?: string;
  messageId: string;
  markdown: string;
}) {
  const { t } = useTranslation("notes");
  const scope = useChatNotes();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const recent = useRecentChatNotes(open);
  const answerId = scope?.chat.agent === "claude" ? claudeUuid : messageId;
  if (!scope || !answerId || !markdown.trim()) return null;
  const { chat, notes } = scope;
  const untitled = t("panel.untitled");
  const choices = noteChoices(notes ?? [], recent ?? []);
  const save = async (noteId?: string) => {
    setSaving(true);
    try {
      const target = chatNoteTarget(chat);
      if (!target) throw new Error("The conversation closed");
      const id = await notesApi.saveAnswer(
        chat.workspaceId,
        noteId,
        { ...target, messageId: answerId },
        markdown,
        t("connections.imageAlt"),
      );
      if (!noteId)
        openConversationNote(chat.workspaceId, chat.tabId, { noteId: id, title: "", updatedAt: 0 });
      showToast({ kind: "info", message: t("connections.savedAnswer") });
      await syncChatNoteLink(target);
    } catch {
      showToast({ kind: "error", message: t("editor.saveError") });
    } finally {
      setSaving(false);
    }
  };
  return (
    <DropdownMenuRoot open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger>
        <IconButton
          label={t("connections.saveAnswer")}
          disabled={saving}
          data-testid="chat-save-answer"
        >
          <NotebookPen className="size-3.5" aria-hidden="true" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t("connections.saveAnswer")}</DropdownMenuLabel>
        {choices.map(({ noteId, title, linked }) => (
          <DropdownMenuItem key={noteId} onSelect={() => void save(noteId)}>
            <span className="flex min-w-0 items-center gap-2">
              <NotebookPen className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{title || untitled}</span>
            </span>
            {linked && (
              <span className="ml-2 shrink-0 text-app-micro text-muted-foreground">
                {t("connections.linkedNote")}
              </span>
            )}
          </DropdownMenuItem>
        ))}
        {choices.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={() => void save()}>
          <span className="flex items-center gap-2">
            <Plus className="size-3.5 text-muted-foreground" aria-hidden="true" />
            {t("panel.new")}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}
