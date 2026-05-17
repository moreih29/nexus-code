import { AlertCircle, ChevronRight, ChevronUp, Folder } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DirEntry } from "../../../../shared/fs/types";
import { ipcCall } from "../../../ipc/client";
import { EmptyState } from "../../ui/empty-state";
import { Skeleton, SkeletonLine } from "../../ui/skeleton";
import { humanizeSshError } from "./ssh-helpers";
import type { SshDirectoryPickerViewProps } from "./types";

// ---------------------------------------------------------------------------
// Private types
// ---------------------------------------------------------------------------

/** Browse session error classification. */
type BrowseErrorKind = "session-expired" | "retryable" | null;

/** Cache entry — stores hover prefetch results. */
interface BrowseCacheEntry {
  readonly entries: readonly DirEntry[];
  readonly truncated: boolean;
}

// Session expiry / disconnect error codes
const SESSION_FATAL_CODES = new Set([
  "ssh.session-expired",
  "ssh.connect-failed",
  "ssh.auth-failed",
]);

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** POSIX path join — append last segment. */
function joinPath(base: string, segment: string): string {
  const clean = base.endsWith("/") ? base : `${base}/`;
  return segment === ".." ? parentPath(base) : `${clean}${segment}`;
}

/** Return POSIX parent path. */
function parentPath(path: string): string {
  const clean = path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
  const idx = clean.lastIndexOf("/");
  if (idx <= 0) return "/";
  return clean.slice(0, idx);
}

/** Extract SSH error kind from an IPC error. */
function extractSshErrorKind(error: unknown): BrowseErrorKind {
  if (!(error instanceof Error)) return "retryable";
  const msg = error.message;
  for (const code of SESSION_FATAL_CODES) {
    if (msg.includes(code)) return "session-expired";
  }
  return "retryable";
}

const PICKER_LIST_HEIGHT = 240; // px — fixed per spec
const HOVER_PREFETCH_DELAY_MS = 150;

// ---------------------------------------------------------------------------
// SshDirectoryPickerView — T4 implementation
// ---------------------------------------------------------------------------

export function SshDirectoryPickerView({
  session,
  onWorkspaceCreated,
  onClose,
  onBack,
  onAddPhaseChange,
}: SshDirectoryPickerViewProps): React.JSX.Element {
  const { sessionId, initialPath, host } = session;

  // Path state
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [pathInput, setPathInput] = useState(initialPath);
  const pathInputRef = useRef<HTMLInputElement>(null);

  // List state
  const [entries, setEntries] = useState<readonly DirEntry[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [truncated, setTruncated] = useState(false);
  const [browseErrorHuman, setBrowseErrorHuman] = useState<string | null>(null);
  const [browseErrorKind, setBrowseErrorKind] = useState<BrowseErrorKind>(null);

  // Add Workspace state
  const [addPhase, setAddPhase] = useState<"idle" | "creating">("idle");
  const [addErrorHuman, setAddErrorHuman] = useState<string | null>(null);

  // Prefetch
  const browseCache = useRef<Map<string, BrowseCacheEntry>>(new Map());
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverAbortRef = useRef<AbortController | null>(null);
  const inFlightAbortRef = useRef<AbortController | null>(null);

  // List load
  const loadPath = useCallback(
    async (path: string, abortSignal?: AbortSignal): Promise<void> => {
      // Cache hit
      const cached = browseCache.current.get(path);
      if (cached) {
        setCurrentPath(path);
        setPathInput(path);
        setEntries(cached.entries);
        setTruncated(cached.truncated);
        setBrowseErrorHuman(null);
        setBrowseErrorKind(null);
        setListLoading(false);
        return;
      }

      setListLoading(true);
      setBrowseErrorHuman(null);
      setBrowseErrorKind(null);

      try {
        const result = await ipcCall("ssh", "browseSession", { sessionId, path });
        if (abortSignal?.aborted) return;

        const dirs = result.entries.filter((e) => e.type === "dir" || e.type === "symlink");
        const sorted = [...dirs].sort((a, b) => a.name.localeCompare(b.name));

        browseCache.current.set(path, { entries: sorted, truncated: result.truncated });
        setCurrentPath(path);
        setPathInput(path);
        setEntries(sorted);
        setTruncated(result.truncated);
        setBrowseErrorHuman(null);
        setBrowseErrorKind(null);
      } catch (error) {
        if (abortSignal?.aborted) return;
        const kind = extractSshErrorKind(error);
        setBrowseErrorHuman(humanizeSshError(error));
        setBrowseErrorKind(kind);
      } finally {
        if (!abortSignal?.aborted) setListLoading(false);
      }
    },
    [sessionId],
  );

  // Initial load — mount-only; initialPath and loadPath are stable for view lifetime.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-only effect
  useEffect(() => {
    const controller = new AbortController();
    inFlightAbortRef.current = controller;
    void loadPath(initialPath, controller.signal).finally(() => {
      if (inFlightAbortRef.current === controller) inFlightAbortRef.current = null;
    });
    // Focus path input
    pathInputRef.current?.focus();
    return () => {
      controller.abort();
    };
  }, []);

  // Drill down
  function drillDown(segment: string): void {
    const targetPath = joinPath(currentPath, segment);

    // Optimistic path bar update
    setPathInput(targetPath);

    // Cancel previous in-flight
    inFlightAbortRef.current?.abort();
    const controller = new AbortController();
    inFlightAbortRef.current = controller;

    // Pessimistic list: show skeleton
    setListLoading(true);
    setAddErrorHuman(null);

    void loadPath(targetPath, controller.signal).finally(() => {
      if (inFlightAbortRef.current === controller) inFlightAbortRef.current = null;
    });
  }

  // Path bar Enter
  function handlePathSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = pathInput.trim();
    if (!trimmed || trimmed === currentPath) return;

    inFlightAbortRef.current?.abort();
    const controller = new AbortController();
    inFlightAbortRef.current = controller;
    setListLoading(true);
    setAddErrorHuman(null);

    void loadPath(trimmed, controller.signal).finally(() => {
      if (inFlightAbortRef.current === controller) inFlightAbortRef.current = null;
    });
  }

  // Hover prefetch
  function handleRowHoverStart(segment: string): void {
    const targetPath = joinPath(currentPath, segment);
    if (browseCache.current.has(targetPath)) return;

    hoverTimerRef.current = setTimeout(() => {
      hoverAbortRef.current?.abort();
      const controller = new AbortController();
      hoverAbortRef.current = controller;

      ipcCall("ssh", "browseSession", { sessionId, path: targetPath })
        .then((result) => {
          if (controller.signal.aborted) return;
          const dirs = result.entries
            .filter((e) => e.type === "dir" || e.type === "symlink")
            .sort((a, b) => a.name.localeCompare(b.name));
          browseCache.current.set(targetPath, { entries: dirs, truncated: result.truncated });
        })
        .catch(() => {
          // Prefetch failure is ignored — will retry on actual click
        });
    }, HOVER_PREFETCH_DELAY_MS);
  }

  function handleRowHoverEnd(): void {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    hoverAbortRef.current?.abort();
    hoverAbortRef.current = null;
  }

  // Add Workspace
  async function handleAddWorkspace(): Promise<void> {
    if (addPhase === "creating" || browseErrorHuman) return;
    setAddPhase("creating");
    setAddErrorHuman(null);
    try {
      const meta = await ipcCall("workspace", "create", {
        location: {
          kind: "ssh",
          host,
          user: session.user,
          port: session.port,
          identityFile: session.identityFile,
          remotePath: currentPath,
          authMode: "interactive",
        },
        // Hand off this browse session's authenticated connection so the
        // workspace boots without a second credential prompt.
        sshBrowseSessionId: sessionId,
      });

      // Record the SSH folder bookmark — before onWorkspaceCreated so
      // it appears in RECENT on the next modal open.
      // Failure is silent — workspace creation already succeeded.
      await ipcCall("folderBookmark", "record", {
        kind: "ssh",
        id: crypto.randomUUID(),
        absPath: currentPath,
        connectionProfileId: session.connectionProfileId,
      }).catch(() => {});

      // Session cleanup is handled by unmount effect — no separate call needed.
      await onWorkspaceCreated(meta);
      onClose();
    } catch (error) {
      setAddErrorHuman(humanizeSshError(error));
      setAddPhase("idle");
    }
  }

  // Session cleanup on Back / workspace add success / modal close — runs on unmount.
  // sessionId is stable for the lifetime of this view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-only cleanup
  useEffect(() => {
    return () => {
      ipcCall("ssh", "closeBrowseSession", { sessionId }).catch(() => {});
    };
  }, []);

  const dirEntries = entries;
  const isAtRoot = currentPath === "/" || currentPath === "";
  const addDisabled = addPhase === "creating" || browseErrorKind === "session-expired";

  // Sync footer primary button state
  useEffect(() => {
    onAddPhaseChange(addPhase, addDisabled);
  }, [addPhase, addDisabled, onAddPhaseChange]);

  return (
    <div className="flex flex-col gap-3">
      {/* Path bar */}
      <form onSubmit={handlePathSubmit} className="flex flex-col gap-1">
        <label htmlFor="picker-path-input" className="text-app-ui-sm text-foreground">
          Path
          <span className="ml-2 text-app-ui-sm text-muted-foreground">
            {session.user ? `${session.user}@${host}` : host}
          </span>
        </label>
        <div className="flex items-center gap-2">
          <input
            id="picker-path-input"
            ref={pathInputRef}
            value={pathInput}
            onChange={(e) => setPathInput(e.currentTarget.value)}
            disabled={addPhase === "creating"}
            placeholder="/home/user/project"
            className="min-w-0 flex-1 rounded-[--radius-control] border border-border bg-background px-2 py-1 font-mono text-app-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-50"
          />
          {!isAtRoot ? (
            <button
              type="button"
              aria-label="Go to parent directory"
              onClick={() => drillDown("..")}
              disabled={listLoading || addPhase === "creating"}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[--radius-control] border border-border bg-background text-muted-foreground outline-none hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50"
            >
              <ChevronUp className="size-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </form>

      {/* Fixed 240px directory list area */}
      <div
        style={{ height: PICKER_LIST_HEIGHT }}
        className="overflow-hidden rounded-[--radius-control] border border-border"
      >
        {listLoading ? (
          // Loading: skeleton rows — no generic spinner
          <Skeleton
            label="Loading directory listing"
            className="h-full gap-0 overflow-hidden px-0 py-0"
          >
            {(["psk-0", "psk-1", "psk-2", "psk-3", "psk-4", "psk-5"] as const).map((k) => (
              <SkeletonLine key={k} className="mx-2 my-1 h-8 rounded-[--radius-control]" />
            ))}
          </Skeleton>
        ) : browseErrorHuman ? (
          // Error: inline card within 240px (height invariant)
          // Redundant encoding: icon + border + bg + fg color
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4">
            <div
              className="flex w-full items-start gap-2 rounded-[--radius-control] border border-[var(--state-error-border)] bg-[var(--state-error-bg)] px-3 py-2"
              role="alert"
            >
              <AlertCircle
                className="mt-0.5 size-3.5 shrink-0 text-[var(--state-error-fg)]"
                aria-hidden="true"
              />
              <span className="min-w-0 text-app-ui-sm text-[var(--state-error-fg)]">
                {browseErrorHuman}
              </span>
            </div>
            {browseErrorKind === "session-expired" ? (
              <p className="text-center text-app-ui-sm text-muted-foreground">
                Use{" "}
                <button
                  type="button"
                  onClick={onBack}
                  className="underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                >
                  ‹ Back
                </button>{" "}
                to reconnect.
              </p>
            ) : (
              <button
                type="button"
                onClick={() => {
                  inFlightAbortRef.current?.abort();
                  const controller = new AbortController();
                  inFlightAbortRef.current = controller;
                  setListLoading(true);
                  void loadPath(currentPath, controller.signal).finally(() => {
                    if (inFlightAbortRef.current === controller) inFlightAbortRef.current = null;
                  });
                }}
                className="text-app-ui-sm text-muted-foreground underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              >
                Retry
              </button>
            )}
          </div>
        ) : dirEntries.length === 0 ? (
          // Empty folder — current path is still a valid workspace root
          <div className="flex h-full items-center justify-center">
            <EmptyState
              tone="status"
              icon={<Folder className="size-5" aria-hidden="true" />}
              title="This folder is empty."
              className="py-4"
            />
          </div>
        ) : (
          // Directory list
          <ul className="h-full overflow-y-auto py-1" aria-label="Directory listing">
            {dirEntries.map((entry) => (
              <li key={entry.name}>
                <button
                  type="button"
                  onClick={() => drillDown(entry.name)}
                  onMouseEnter={() => handleRowHoverStart(entry.name)}
                  onMouseLeave={handleRowHoverEnd}
                  disabled={addPhase === "creating"}
                  className="flex min-h-[44px] w-full items-center gap-2 px-3 py-2 text-left text-app-ui-sm text-foreground outline-none hover:bg-[var(--state-hover-bg)] focus-visible:bg-[var(--state-hover-bg)] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                >
                  <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  <ChevronRight
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </button>
              </li>
            ))}
            {truncated ? (
              <li>
                <p className="px-3 py-1.5 text-app-ui-sm text-muted-foreground">
                  Some entries are hidden (listing truncated).
                </p>
              </li>
            ) : null}
          </ul>
        )}
      </div>

      {/* Add error — humanised, redundant encoding */}
      {addErrorHuman ? (
        <div
          className="flex items-start gap-2 rounded-[--radius-control] border border-[var(--state-error-border)] bg-[var(--state-error-bg)] px-2 py-2"
          role="alert"
        >
          <AlertCircle
            className="mt-0.5 size-3.5 shrink-0 text-[var(--state-error-fg)]"
            aria-hidden="true"
          />
          <span className="min-w-0 text-app-ui-sm text-[var(--state-error-fg)]">
            {addErrorHuman}
          </span>
        </div>
      ) : null}

      {/* Hidden trigger button for footer primary button */}
      <button
        id="picker-add-workspace-trigger"
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        className="sr-only"
        onClick={() => void handleAddWorkspace()}
      />
    </div>
  );
}
