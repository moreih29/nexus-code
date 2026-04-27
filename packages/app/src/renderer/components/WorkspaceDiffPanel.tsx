import { useCallback, useEffect, useMemo, useState } from "react";
import { GitCompare, RefreshCw } from "lucide-react";

import type {
  WorkspaceDiffRequest,
  WorkspaceDiffResult,
} from "../../../../shared/src/contracts/workspace/workspace-diff";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { EmptyState } from "./EmptyState";
import { ScrollArea } from "./ui/scroll-area";

export interface WorkspaceDiffPanelProps {
  workspacePath: string | null;
  activeWorkspaceName?: string | null;
  refreshSignal?: number | string;
  readWorkspaceDiff: (request: WorkspaceDiffRequest) => Promise<WorkspaceDiffResult>;
}

export interface WorkspaceDiffPanelViewProps {
  workspacePath: string | null;
  activeWorkspaceName?: string | null;
  result: WorkspaceDiffResult | null;
  selectedFilePath: string | null;
  loading: boolean;
  errorMessage?: string | null;
  onSelectFile?: (filePath: string) => void;
  onRefresh?: () => void;
}

export function WorkspaceDiffPanel({
  workspacePath,
  activeWorkspaceName,
  refreshSignal,
  readWorkspaceDiff,
}: WorkspaceDiffPanelProps): JSX.Element {
  const [result, setResult] = useState<WorkspaceDiffResult | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    setSelectedFilePath(null);
    setResult(null);
    setErrorMessage(null);
  }, [workspacePath]);

  const refresh = useCallback(() => {
    if (!workspacePath) {
      setResult(null);
      setErrorMessage(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setErrorMessage(null);
    void readWorkspaceDiff({ workspacePath, filePath: selectedFilePath })
      .then((nextResult) => {
        setResult(nextResult);
        if (nextResult.available) {
          setSelectedFilePath(nextResult.selectedFilePath);
        }
      })
      .catch((error) => {
        setResult(null);
        setErrorMessage(error instanceof Error ? error.message : "Unable to read workspace diff.");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [readWorkspaceDiff, selectedFilePath, workspacePath]);

  useEffect(() => {
    refresh();
  }, [refresh, refreshSignal]);

  return (
    <WorkspaceDiffPanelView
      workspacePath={workspacePath}
      activeWorkspaceName={activeWorkspaceName}
      result={result}
      selectedFilePath={selectedFilePath}
      loading={loading}
      errorMessage={errorMessage}
      onSelectFile={setSelectedFilePath}
      onRefresh={refresh}
    />
  );
}

export function WorkspaceDiffPanelView({
  workspacePath,
  activeWorkspaceName,
  result,
  selectedFilePath,
  loading,
  errorMessage,
  onSelectFile,
  onRefresh,
}: WorkspaceDiffPanelViewProps): JSX.Element {
  if (!workspacePath) {
    return (
      <div data-component="workspace-diff-panel" className="h-full">
        <EmptyState
          icon={GitCompare}
          title="No workspace selected"
          description="Open a workspace to review git changes produced around Claude Code turns."
        />
      </div>
    );
  }

  const header = DiffHeader({
    activeWorkspaceName,
    result,
    loading,
    onRefresh,
  });

  if (errorMessage) {
    return (
      <section data-component="workspace-diff-panel" className="flex h-full min-h-0 flex-col">
        {header}
        <EmptyState icon={GitCompare} title="Diff read failed" description={errorMessage} />
      </section>
    );
  }

  if (!result && loading) {
    return (
      <section data-component="workspace-diff-panel" className="flex h-full min-h-0 flex-col">
        {header}
        <PanelMessage>Loading workspace diff…</PanelMessage>
      </section>
    );
  }

  if (result && !result.available) {
    return (
      <section data-component="workspace-diff-panel" className="flex h-full min-h-0 flex-col">
        {header}
        <EmptyState icon={GitCompare} title="Diff unavailable" description={result.reason} />
      </section>
    );
  }

  const files = result?.available ? result.files : [];
  if (files.length === 0) {
    return (
      <section data-component="workspace-diff-panel" className="flex h-full min-h-0 flex-col">
        {header}
        <EmptyState
          icon={GitCompare}
          title="No changes"
          description="No git working tree changes are currently visible in this workspace."
        />
      </section>
    );
  }

  const selectedPath = selectedFilePath ?? (result?.available ? result.selectedFilePath : null);
  const selectedDiff = result?.available ? result.diff : "";

  return (
    <section data-component="workspace-diff-panel" className="flex h-full min-h-0 flex-col">
      {header}
      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] border-t-0 md:grid-cols-[minmax(8rem,0.9fr)_minmax(0,1.4fr)] md:grid-rows-1">
        <ScrollArea className="min-h-0 border-b border-border md:border-b-0 md:border-r">
          <ol className="space-y-1 p-2" aria-label="Changed files">
            {files.map((file) => {
              const active = file.path === selectedPath;
              return (
                <li key={`${file.status}:${file.path}`}>
                  <button
                    type="button"
                    data-diff-file-active={active ? "true" : "false"}
                    onClick={() => onSelectFile?.(file.path)}
                    className={cn(
                      "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground",
                      active && "bg-accent text-accent-foreground",
                    )}
                  >
                    <span className="shrink-0 rounded border border-border px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {file.status.trim() || "·"}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{file.path}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{file.kind}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </ScrollArea>
        <ScrollArea className="min-h-0">
          <pre className="min-h-full overflow-visible whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-normal text-muted-foreground">
            {selectedDiff || "No textual diff available for the selected file."}
          </pre>
        </ScrollArea>
      </div>
    </section>
  );
}

function DiffHeader({
  activeWorkspaceName,
  result,
  loading,
  onRefresh,
}: {
  activeWorkspaceName?: string | null;
  result: WorkspaceDiffResult | null;
  loading: boolean;
  onRefresh?: () => void;
}): JSX.Element {
  const count = result?.available ? result.files.length : 0;
  return (
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2">
      <div className="min-w-0">
        <h3 className="truncate text-xs font-semibold uppercase tracking-[0.14em] text-foreground">
          Workspace diff
        </h3>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {activeWorkspaceName ?? "Active workspace"}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          {loading ? "Loading" : `${count} files`}
        </span>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh workspace diff"
        >
          <RefreshCw aria-hidden="true" className={cn("size-3", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>
    </header>
  );
}

function PanelMessage({ children }: { children: string }): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
      {children}
    </div>
  );
}
