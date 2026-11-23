/**
 * The notes view of a workspace on another computer: the local view's title
 * row, search and rows, to read only. Its list is what notes.list tells
 * (title and time), read when shown, on reconnecting, and now and then
 * while shown.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type PeerWorkspaceTarget,
  peerTabId,
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../state/stores/peer-workspace";
import { NotesPanelView } from "../notes/notes-panel";
import { EmptyState } from "../ui/empty-state";
import { PeerReadOnlyBadge } from "./labels";
import { listPeerNotes, PEER_NOTES_REFRESH_MS, type PeerNoteRow } from "./notes-model";

export function PeerNotesPanel({
  target,
  canRead,
  rejoin,
}: {
  target: PeerWorkspaceTarget;
  /** Shown, in reach, and that computer serves its notes. */
  canRead: boolean;
  rejoin: number;
}) {
  const { t } = useTranslation();
  const id = peerTargetId(target);
  const { deviceId, workspaceId } = target;
  const [notes, setNotes] = useState<readonly PeerNoteRow[] | null>(null);
  const [error, setError] = useState(false);
  const activeNoteId = usePeerWorkspaceStore((s) => {
    const view = s.views[id];
    const tab = view?.tabs.find((item) => peerTabId(item) === view.activePath);
    return tab?.type === "peer.note" ? tab.noteId : null;
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again on reconnect
  useEffect(() => {
    if (!canRead) return;
    const controller = new AbortController();
    const { signal } = controller;
    const load = () =>
      void listPeerNotes({ deviceId, workspaceId }, signal).then(
        (result) => {
          if (signal.aborted) return;
          // A failed later read keeps the list last seen, as the other views do.
          if (result.ok) setNotes(result.value.notes);
          setError(!result.ok);
        },
        () => {},
      );
    load();
    const timer = setInterval(load, PEER_NOTES_REFRESH_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [canRead, rejoin, deviceId, workspaceId]);

  if (!notes && !canRead) {
    return <EmptyState title={t("peerWorkspace.connectionUnavailable")} tone="status" />;
  }
  return (
    <NotesPanelView
      notes={notes}
      error={error && !notes}
      activeNoteId={activeNoteId}
      onOpen={(note) =>
        usePeerWorkspaceStore.getState().openNote(id, { noteId: note.id, title: note.title })
      }
      badge={<PeerReadOnlyBadge compact />}
      emptyText={t("notes:panel.none")}
      searchPlaceholder={t("notes:panel.searchTitlePlaceholder")}
    />
  );
}
