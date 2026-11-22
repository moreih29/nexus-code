import { NotebookPen } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { LinkedNote } from "../../../shared/types/notes";
import { useChatNotes } from "../../services/notes/chat-notes";
import { openConversationNote } from "../../services/notes/open-conversation-note";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

/** The local Claude and Codex views are shared by both layouts. */
export function ConversationNoteChip() {
  const { t } = useTranslation("notes");
  const scope = useChatNotes();
  const notes = scope?.notes;
  const latest = notes?.[0];
  if (!scope || !notes || !latest) return null;
  const multiple = notes.length > 1;
  const name = (note: LinkedNote) => note.title || t("panel.untitled");
  const label = t("conversations.fromNote", { title: name(latest) });
  const open = (note: LinkedNote) =>
    openConversationNote(scope.chat.workspaceId, scope.chat.tabId, note);
  const chip = (
    <button
      type="button"
      onClick={multiple ? undefined : () => open(latest)}
      title={label}
      data-testid="conversation-note-chip"
      className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border px-2 py-0.5 text-app-micro text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground"
    >
      <NotebookPen className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
      {multiple && <span className="shrink-0">+{notes.length - 1}</span>}
    </button>
  );
  return (
    <div className="flex min-w-0 shrink-0 items-center border-b border-border px-2 py-1">
      {multiple ? (
        <DropdownMenuRoot>
          <DropdownMenuTrigger>{chip}</DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {notes.map((note) => (
              <DropdownMenuItem key={note.noteId} onSelect={() => open(note)}>
                <span className="truncate">{name(note)}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenuRoot>
      ) : (
        chip
      )}
    </div>
  );
}
