import { NotebookPen } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NoteConversation } from "../../../shared/notes/links";
import type { LinkedNote } from "../../../shared/types/notes";
import { notesApi } from "../../services/notes/api";
import { noteLocation } from "../../services/notes/conversation";
import { openConversationNote } from "../../services/notes/open-conversation-note";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

function useConversationNotes(
  { workspaceId, tabId, agent, session }: NoteConversation,
  visible: boolean,
) {
  const location = useWorkspacesStore(({ workspaces }) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    return workspace && noteLocation(workspace, workspaces);
  });
  const key = JSON.stringify([workspaceId, tabId, agent, session, location]);
  const [saved, setSaved] = useState<{ key: string; notes: LinkedNote[] }>();
  useEffect(() => {
    if (!visible || !location) return;
    let revision = 0;
    let current: LinkedNote[] | undefined;
    const read = () => {
      const request = ++revision;
      void notesApi.linksOfConversation({ workspaceId, tabId, agent, session }).then(
        (notes) => {
          if (request !== revision) return;
          current = notes;
          setSaved({ key, notes });
        },
        () => {},
      );
    };
    const stopLinks = notesApi.onLinksChanged((event) => {
      if (event.locationKey === location) read();
    });
    const stopNotes = notesApi.onChanged((event) => {
      if (
        event.locationKey === location &&
        event.change !== "created" &&
        (!event.noteId || !current || current.some((note) => note.noteId === event.noteId))
      ) {
        read();
      }
    });
    read();
    return () => {
      revision++;
      stopLinks();
      stopNotes();
    };
  }, [visible, location, key, workspaceId, tabId, agent, session]);
  return saved?.key === key ? saved.notes : undefined;
}

/** The local Claude and Codex views are shared by both layouts. */
export function ConversationNoteChip({
  visible,
  ...chat
}: NoteConversation & { visible: boolean }) {
  const { t } = useTranslation("notes");
  const notes = useConversationNotes(chat, visible);
  const latest = notes?.[0];
  if (!notes || !latest) return null;
  const multiple = notes.length > 1;
  const name = (note: LinkedNote) => note.title || t("panel.untitled");
  const label = t("conversations.fromNote", { title: name(latest) });
  const open = (note: LinkedNote) => openConversationNote(chat.workspaceId, chat.tabId, note);
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
