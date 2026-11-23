import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LogEntry } from "../../../../../shared/git/types";
import { openOrRevealCommitTab } from "../../../../state/operations";
import { useGitStore } from "../../../../state/stores/git";
import { GitInlineBanner } from "../panel/inline-banner";
import { HistoryCommitMenu, type HistoryCommitMenuTarget } from "./commit-menu";
import { HistoryList } from "./list";
import { RefChipList } from "./ref-chip";
import { HistoryRefSwitcher } from "./ref-switcher";
import type { HistoryRowMenuRequest } from "./row";
import { HistorySearch } from "./search";
import { useGitHistoryLoad } from "./use-history-load";

interface HistoryPanelProps {
  workspaceId: string;
  refName: string;
  busy?: boolean;
  onRefChange: (refName: string) => void;
}

export function HistoryPanel({
  workspaceId,
  refName,
  busy = false,
  onRefChange,
}: HistoryPanelProps) {
  const { t } = useTranslation("files");
  const cherryPick = useGitStore((state) => state.cherryPick);
  const checkoutDetached = useGitStore((state) => state.checkoutDetached);
  const resetSoft = useGitStore((state) => state.resetSoft);
  const branchSignature = useGitStore((state) => {
    const info = state.sessions.get(workspaceId)?.branchInfo;
    if (!info) return null;
    return `${info.current}|${info.upstream ?? ""}|${info.ahead}|${info.behind}|${info.isUnborn}`;
  });

  const {
    loadState,
    laneState,
    query,
    debouncedQuery,
    selectedSha,
    setQuery,
    setSelectedSha,
    loadMore,
    refresh,
  } = useGitHistoryLoad(workspaceId, refName);

  const [menuTarget, setMenuTarget] = useState<HistoryCommitMenuTarget | null>(null);
  const [banner, setBanner] = useState<{ variant: "info" | "error"; message: string } | null>(null);

  function handleRefChange(nextRefName: string) {
    onRefChange(nextRefName);
    setQuery("");
  }

  const lastBranchSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastBranchSignatureRef.current === null) {
      lastBranchSignatureRef.current = branchSignature;
      return;
    }
    if (lastBranchSignatureRef.current === branchSignature) return;
    lastBranchSignatureRef.current = branchSignature;
    if (debouncedQuery.trim().length > 0) return;
    refresh();
  }, [branchSignature, debouncedQuery, refresh]);

  function openMenu(request: HistoryRowMenuRequest): void {
    setMenuTarget({
      entry: request.entry,
      detail: null,
      point: request.point,
    });
  }

  function openCommit(entry: LogEntry): void {
    setSelectedSha(entry.sha);
    openOrRevealCommitTab(workspaceId, entry.sha);
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <HistoryRefSwitcher
        workspaceId={workspaceId}
        refName={refName}
        searchQuery={query}
        disabled={busy}
        onRefChange={handleRefChange}
        onRefresh={refresh}
      />
      <HistorySearch
        value={query}
        disabled={busy}
        onChange={setQuery}
        onClear={() => setQuery("")}
      />
      {banner && (
        <GitInlineBanner
          variant={banner.variant}
          message={banner.message}
          dismiss={{ label: t("common:action.dismiss"), onDismiss: () => setBanner(null) }}
        />
      )}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="min-w-0 flex-1 overflow-auto app-scrollbar">
          <HistoryList
            entries={loadState.entries}
            selectedSha={selectedSha}
            loading={loadState.loading}
            loadingMore={loadState.loadingMore}
            hasMore={loadState.hasMore}
            searchQuery={query}
            errorMessage={loadState.errorMessage}
            laneState={laneState}
            renderRefSlot={(entry, _index, breakpoint) => (
              <RefChipList
                refs={entry.refs}
                currentRefName={refName}
                breakpoint={breakpoint}
                onRefChange={handleRefChange}
                onOpenMenu={(event) => {
                  openMenu({ entry, point: { x: event.clientX, y: event.clientY } });
                }}
              />
            )}
            onSelect={(entry) => setSelectedSha(entry.sha)}
            onOpen={openCommit}
            onLoadMore={loadMore}
            onOpenMenu={openMenu}
            onClearSearch={() => setQuery("")}
          />
        </div>
      </div>
      <HistoryCommitMenu
        target={menuTarget}
        onClose={() => setMenuTarget(null)}
        actions={{
          cherryPick: (sha) => {
            void cherryPick(workspaceId, sha).then((ok) => {
              if (ok) setBanner({ variant: "info", message: t("git.history.cherryPickStarted") });
            });
          },
          checkoutDetached: (sha) => {
            void checkoutDetached(workspaceId, sha);
          },
          resetSoft: (sha) => {
            void resetSoft(workspaceId, sha);
          },
        }}
      />
    </div>
  );
}
