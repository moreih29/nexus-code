import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import type { NoteConversation } from "../../../shared/notes/links";
import type { NoteSummary } from "../../../shared/notes/types";
import type { LinkedNote } from "../../../shared/types/notes";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { notesApi } from "./api";
import { noteLocation } from "./conversation";

interface ChatNotesScope {
  chat: NoteConversation;
  location: string;
  notes?: LinkedNote[];
}

const ChatNotes = createContext<ChatNotesScope | undefined>(undefined);

export function useChatNotes() {
  return useContext(ChatNotes);
}

/** Mounted by this device's chat tabs. Peer panes have no notes scope. */
export function ChatNotesProvider({
  workspaceId,
  tabId,
  agent,
  session,
  visible,
  children,
}: NoteConversation & { visible: boolean; children: ReactNode }) {
  const chat = useMemo(
    () => ({ workspaceId, tabId, agent, session }),
    [workspaceId, tabId, agent, session],
  );
  const location = useWorkspacesStore(({ workspaces }) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    return workspace && noteLocation(workspace, workspaces);
  });
  const notes = useConversationNotes(chat, visible ? location : undefined);
  const value = useMemo(() => location && { chat, location, notes }, [chat, location, notes]);
  return <ChatNotes.Provider value={value || undefined}>{children}</ChatNotes.Provider>;
}

function useConversationNotes(
  { workspaceId, tabId, agent, session }: NoteConversation,
  location: string | undefined,
) {
  const key = JSON.stringify([workspaceId, tabId, agent, session, location]);
  const [saved, setSaved] = useState<{ key: string; notes: LinkedNote[] }>();
  useEffect(() => {
    if (!location) return;
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
  }, [location, key, workspaceId, tabId, agent, session]);
  return saved?.key === key ? saved.notes : undefined;
}

export function useRecentChatNotes(open: boolean) {
  const scope = useChatNotes();
  const workspaceId = scope?.chat.workspaceId;
  const location = scope?.location;
  const [saved, setSaved] = useState<{ location: string; notes: NoteSummary[] }>();
  useEffect(() => {
    if (!open || !workspaceId || !location) return;
    let revision = 0;
    const read = () => {
      const request = ++revision;
      void notesApi.list(workspaceId).then(
        (notes) => {
          if (request === revision) setSaved({ location, notes });
        },
        () => {},
      );
    };
    const stop = notesApi.onChanged((event) => {
      if (event.locationKey === location) read();
    });
    read();
    return () => {
      revision++;
      stop();
    };
  }, [open, location, workspaceId]);
  return saved?.location === location ? saved?.notes : undefined;
}
