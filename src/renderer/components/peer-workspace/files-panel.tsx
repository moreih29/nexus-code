import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { RoomPeer } from "../../../shared/remote/room";
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
import { PeerSearchPanel } from "./search-panel";
import { PeerSessionsPanel } from "./sessions-panel";

/** What a workspace on another computer shows of the local panel's views. */
const PEER_FILES_MODES: readonly PeerFilesMode[] = ["tree", "search", "git", "agents"];

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
}) {
  const { t } = useTranslation();
  const id = peerTargetId(target);
  // Kept per workspace while the app runs, as a local workspace's is.
  const mode = usePeerWorkspaceStore((s) => (s.views[id] ?? EMPTY_PEER_VIEW).filesMode ?? "tree");
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  return (
    <>
      <FilesPanelModeBar<PeerFilesMode>
        modes={PEER_FILES_MODES}
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
              {/* ErrorBoundary: a crash in one view leaves the others working, as locally. */}
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
              <PeerSessionsPanel target={target} peer={peer} />
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
        </>
      )}
    </>
  );
}
