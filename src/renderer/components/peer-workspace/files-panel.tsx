import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { RoomPeer } from "../../../shared/remote/room";
import type { PeerSessions } from "../../services/remote/room";
import {
  EMPTY_PEER_VIEW,
  type PeerFilesMode,
  type PeerWorkspaceTarget,
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../state/stores/peer-workspace";
import { FilesPanelModeBar } from "../files/mode-bar";
import { EmptyState } from "../ui/empty-state";
import { ErrorBoundary } from "../ui/error-boundary";
import { KeptMounted } from "../ui/kept-mounted";
import { PeerFileTree } from "./file-tree";
import { PeerGitPanel } from "./git-panel";
import { PeerNotesPanel } from "./notes-panel";
import { PeerSearchPanel } from "./search-panel";
import { PeerSessionsPanel } from "./sessions-panel";

const PEER_FILES_MODES: readonly PeerFilesMode[] = ["tree", "search", "git", "agents", "notes"];
const PEER_FILES_MODES_NO_NOTES = PEER_FILES_MODES.filter((mode) => mode !== "notes");

export function PeerFilesPanel({
  target,
  peer,
  missing,
  canRead,
  updateNeeded,
  rejoin,
  canReadGit,
  gitUpdateNeeded,
  refreshGit,
  sessionHint,
  listing,
  canReadNotes,
}: {
  target: PeerWorkspaceTarget;
  peer?: RoomPeer;
  missing: boolean;
  canRead: boolean;
  updateNeeded: boolean;
  rejoin: number;
  canReadGit: boolean;
  gitUpdateNeeded: boolean;
  refreshGit: () => void;
  sessionHint: number;
  listing?: PeerSessions;
  canReadNotes: boolean;
}) {
  const { t } = useTranslation();
  const id = peerTargetId(target);
  const picked = usePeerWorkspaceStore((s) => (s.views[id] ?? EMPTY_PEER_VIEW).filesMode ?? "tree");
  const notes = peer ? (peer.serves?.includes("notes") ?? false) : picked === "notes";
  const mode = picked === "notes" && !notes ? "tree" : picked;
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  return (
    <>
      <FilesPanelModeBar<PeerFilesMode>
        modes={notes ? PEER_FILES_MODES : PEER_FILES_MODES_NO_NOTES}
        active={mode}
        onSelect={(next) => {
          usePeerWorkspaceStore.getState().setFilesMode(id, next);
          if (next === "search") setSearchFocusRequest((n) => n + 1);
        }}
      />
      {missing ? (
        <EmptyState title={t("peerWorkspace.missingWorkspace")} tone="status" />
      ) : (
        <>
          {updateNeeded ? (
            (mode === "tree" || mode === "search") && (
              <EmptyState title={t("peerWorkspace.updateNeeded")} tone="status" />
            )
          ) : (
            <>
              <KeptMounted shown={mode === "tree"}>
                <ErrorBoundary logSource="peer-file-tree-panel">
                  <PeerFileTree
                    target={target}
                    canRead={canRead && mode === "tree"}
                    rejoin={rejoin}
                    sessionHint={sessionHint}
                  />
                </ErrorBoundary>
              </KeptMounted>
              <KeptMounted shown={mode === "search"}>
                <ErrorBoundary logSource="peer-search-panel">
                  <PeerSearchPanel
                    target={target}
                    canRead={canRead && mode === "search"}
                    rejoin={rejoin}
                    focusRequest={searchFocusRequest}
                  />
                </ErrorBoundary>
              </KeptMounted>
            </>
          )}
          {mode === "agents" && (
            <ErrorBoundary logSource="peer-agent-list-panel">
              <PeerSessionsPanel target={target} peer={peer} listing={listing} />
            </ErrorBoundary>
          )}
          <KeptMounted shown={mode === "git"}>
            <ErrorBoundary logSource="peer-git-panel">
              <PeerGitPanel
                target={target}
                canRead={canReadGit && mode === "git"}
                updateNeeded={gitUpdateNeeded}
                refresh={refreshGit}
                rejoin={rejoin}
              />
            </ErrorBoundary>
          </KeptMounted>
          {notes && (
            <KeptMounted shown={mode === "notes"}>
              <ErrorBoundary logSource="peer-notes-panel">
                <PeerNotesPanel
                  target={target}
                  canRead={canReadNotes && mode === "notes"}
                  rejoin={rejoin}
                />
              </ErrorBoundary>
            </KeptMounted>
          )}
        </>
      )}
    </>
  );
}
