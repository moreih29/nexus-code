import { ChevronRight, CornerLeftUp, Folder } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DirEntry } from "../../../../shared/fs/types";
import {
  browseSshSession,
  closeSshBrowseSession,
  createSshWorkspace,
  prefetchSshDirectory,
  recordSshBookmark,
} from "../../../services/workspace";
import { EmptyState } from "../../ui/empty-state";
import { Skeleton, SkeletonLine } from "../../ui/skeleton";
import { ErrorNotice } from "./error-notice";
import { humanizeSshError } from "./ssh-helpers";
import type { SshDirectoryPickerViewProps } from "./types";
import { type BrowseCacheEntry, usePathAutocomplete } from "./use-path-autocomplete";

// ---------------------------------------------------------------------------
// Private types
// ---------------------------------------------------------------------------

/**
 * Browse session error classification.
 * - "path-not-found": the typed path does not exist. Non-destructive — the
 *   previous valid listing stays on screen and the error is shown inline by
 *   the path bar rather than replacing the tree.
 * - "session-expired": connection/auth is gone — the tree is meaningless, so
 *   the error replaces it and offers a reconnect path.
 * - "retryable": transient failure — replace the tree with a Retry affordance.
 */
type BrowseErrorKind = "session-expired" | "path-not-found" | "retryable" | null;

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
  if (msg.includes("ssh.path-not-found")) return "path-not-found";
  for (const code of SESSION_FATAL_CODES) {
    if (msg.includes(code)) return "session-expired";
  }
  return "retryable";
}

const HOVER_PREFETCH_DELAY_MS = 150;

/** Listbox element id for the path autocomplete dropdown. */
const PATH_SUGGEST_LISTBOX_ID = "picker-path-suggestions";

// ---------------------------------------------------------------------------
// SshDirectoryPickerView — T4 implementation
// ---------------------------------------------------------------------------

/** Imperative handle — lets the dialog footer button drive the picker's primary action. */
export interface SshDirectoryPickerHandle {
  /** Invoke the "Add workspace" action (equivalent to clicking the footer primary button). */
  submit(): void;
}

export function SshDirectoryPickerView({
  session,
  onWorkspaceCreated,
  onClose,
  onBack,
  onAddPhaseChange,
  ref,
}: SshDirectoryPickerViewProps & {
  readonly ref?: React.Ref<SshDirectoryPickerHandle>;
}): React.JSX.Element {
  const { t } = useTranslation();
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
  // Non-destructive "path not found" notice: shown inline by the path bar
  // while the previous valid listing stays visible (does not wipe the tree).
  const [pathErrorHuman, setPathErrorHuman] = useState<string | null>(null);

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
        setEntries(cached.entries);
        setTruncated(cached.truncated);
        setBrowseErrorHuman(null);
        setBrowseErrorKind(null);
        setPathErrorHuman(null);
        setListLoading(false);
        return;
      }

      setListLoading(true);
      setBrowseErrorHuman(null);
      setBrowseErrorKind(null);

      try {
        const result = await browseSshSession(sessionId, path);
        if (abortSignal?.aborted) return;

        browseCache.current.set(path, { entries: result.entries, truncated: result.truncated });
        setCurrentPath(path);
        setEntries(result.entries);
        setTruncated(result.truncated);
        setBrowseErrorHuman(null);
        setBrowseErrorKind(null);
        setPathErrorHuman(null);
      } catch (error) {
        if (abortSignal?.aborted) return;
        const kind = extractSshErrorKind(error);
        if (kind === "path-not-found") {
          // Non-destructive: the typed path is missing, but the previous listing
          // (currentPath/entries) is untouched. Surface the error inline by the
          // path bar and leave the tree on screen.
          setPathErrorHuman(humanizeSshError(error));
        } else {
          setBrowseErrorHuman(humanizeSshError(error));
          setBrowseErrorKind(kind);
        }
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

  // Begin a directory navigation in the main list: cancel any in-flight load,
  // show the skeleton, then load the target path. Shared by folder clicks, the
  // path bar (Enter), and autocomplete selection.
  function navigateTo(targetPath: string): void {
    inFlightAbortRef.current?.abort();
    const controller = new AbortController();
    inFlightAbortRef.current = controller;

    setListLoading(true);
    setAddErrorHuman(null);

    void loadPath(targetPath, controller.signal).finally(() => {
      if (inFlightAbortRef.current === controller) inFlightAbortRef.current = null;
    });
  }

  // Drill down — click a folder row in the main list.
  function drillDown(segment: string): void {
    const targetPath = joinPath(currentPath, segment);
    setPathInput(targetPath);
    autocomplete.closeSuggestions();
    navigateTo(targetPath);
  }

  // Path bar Enter with no highlighted suggestion — navigate to the typed path.
  function handlePathSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = pathInput.trim();
    autocomplete.closeSuggestions();
    if (!trimmed || trimmed === currentPath) return;
    setPathInput(trimmed);
    navigateTo(trimmed);
  }

  // Path autocomplete combobox — owns the dropdown listing, keyboard nav, and
  // click-outside dismissal. Committing a suggestion moves the main list into
  // that folder and appends a trailing slash so the dropdown keeps drilling.
  const autocomplete = usePathAutocomplete({
    sessionId,
    pathInput,
    browseCache,
    onSelectPath: (targetPath) => {
      setPathInput(`${targetPath}/`);
      navigateTo(targetPath);
      pathInputRef.current?.focus();
    },
  });

  function handlePathInputChange(value: string): void {
    setPathInput(value);
    setPathErrorHuman(null);
    autocomplete.handleInputChange();
  }

  // Hover prefetch
  function handleRowHoverStart(segment: string): void {
    const targetPath = joinPath(currentPath, segment);
    if (browseCache.current.has(targetPath)) return;

    hoverTimerRef.current = setTimeout(() => {
      hoverAbortRef.current?.abort();
      const controller = new AbortController();
      hoverAbortRef.current = controller;

      prefetchSshDirectory(sessionId, targetPath).then((result) => {
        if (controller.signal.aborted || !result) return;
        browseCache.current.set(targetPath, {
          entries: result.entries,
          truncated: result.truncated,
        });
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
      // createAndConnect with sshBrowseSessionId: the directory-picker path
      // is already authenticated (the user browsed via the browse session).
      // The main handler detects the browseSessionId and adopts that
      // ControlMaster, skipping a second auth prompt.
      const result = await createSshWorkspace({
        host,
        user: session.user,
        port: session.port,
        identityFile: session.identityFile,
        remotePath: currentPath,
        authMode: "interactive",
        // Hand off the browse session's authenticated connection so the
        // workspace boots without a second credential prompt.
        sshBrowseSessionId: sessionId,
      });

      if (!result.ok) {
        // Cancellation or auth failure after the browse session — surface error.
        setAddErrorHuman(result.message);
        setAddPhase("idle");
        return;
      }

      // Record the SSH folder bookmark — before onWorkspaceCreated so
      // it appears in RECENT on the next modal open.
      // Failure is silent — workspace creation already succeeded.
      await recordSshBookmark({
        id: crypto.randomUUID(),
        absPath: currentPath,
        connectionProfileId: session.connectionProfileId,
      }).catch(() => {});

      // Session cleanup is handled by unmount effect — no separate call needed.
      await onWorkspaceCreated(result.value);
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
      void closeSshBrowseSession(sessionId);
    };
  }, []);

  const dirEntries = entries;
  const isAtRoot = currentPath === "/" || currentPath === "";
  const addDisabled = addPhase === "creating" || browseErrorKind === "session-expired";

  // Sync footer primary button state
  useEffect(() => {
    onAddPhaseChange(addPhase, addDisabled);
  }, [addPhase, addDisabled, onAddPhaseChange]);

  // The footer primary button lives in the dialog shell; expose the action so it
  // can invoke handleAddWorkspace directly (no hidden-button / DOM-id handshake).
  useImperativeHandle(ref, () => ({
    submit: () => {
      void handleAddWorkspace();
    },
  }));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* Path bar — pinned (shrink-0) so it stays visible while only the
          directory list below scrolls. */}
      <form onSubmit={handlePathSubmit} className="flex shrink-0 flex-col gap-1">
        {/* Connection identity (user@host) heads the path field. */}
        <div className="truncate text-app-body-emphasis text-foreground">
          {session.user ? `${session.user}@${host}` : host}
        </div>
        <div className="relative flex items-center gap-2" ref={autocomplete.comboboxRef}>
          {!isAtRoot ? (
            <button
              type="button"
              aria-label={t("sshPicker.go_to_parent")}
              onClick={() => drillDown("..")}
              disabled={listLoading || addPhase === "creating"}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-(--radius-control) border border-border bg-background text-muted-foreground outline-none hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50"
            >
              <CornerLeftUp className="size-4" aria-hidden="true" />
            </button>
          ) : (
            // Placeholder keeps the path input's left edge fixed at filesystem root.
            <div className="size-7 shrink-0" aria-hidden="true" />
          )}
          <input
            id="picker-path-input"
            aria-label={t("sshPicker.remote_path")}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={autocomplete.suggestionsOpen}
            aria-controls={PATH_SUGGEST_LISTBOX_ID}
            aria-activedescendant={
              autocomplete.suggestionsOpen && autocomplete.activeSuggestionIndex >= 0
                ? `picker-path-option-${autocomplete.activeSuggestionIndex}`
                : undefined
            }
            ref={pathInputRef}
            value={pathInput}
            onChange={(e) => handlePathInputChange(e.currentTarget.value)}
            onKeyDown={autocomplete.handleKeyDown}
            disabled={addPhase === "creating"}
            autoComplete="off"
            placeholder="/home/user/project"
            className="min-w-0 flex-1 rounded-(--radius-control) border border-border bg-background px-2 py-1 font-mono text-app-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-50"
          />
          {autocomplete.suggestionsOpen && addPhase !== "creating" ? (
            <div
              id={PATH_SUGGEST_LISTBOX_ID}
              role="listbox"
              aria-label={t("sshPicker.path_suggestions")}
              className="absolute left-9 right-0 top-[calc(100%+4px)] z-20 max-h-56 overflow-y-auto floating-panel p-1"
            >
              {autocomplete.suggestionsDirLoading ? (
                <div className="px-2 py-2 text-app-ui-sm text-muted-foreground">
                  {t("sshPicker.loading")}
                </div>
              ) : autocomplete.filteredSuggestions.length === 0 ? (
                <div className="px-2 py-2 text-app-ui-sm text-muted-foreground">
                  {t("sshPicker.no_matching_folders")}
                </div>
              ) : (
                autocomplete.filteredSuggestions.map((entry, index) => (
                  <button
                    key={entry.name}
                    id={`picker-path-option-${index}`}
                    ref={
                      index === autocomplete.activeSuggestionIndex
                        ? autocomplete.activeOptionRef
                        : null
                    }
                    type="button"
                    role="option"
                    aria-selected={index === autocomplete.activeSuggestionIndex}
                    onClick={() => autocomplete.selectSuggestion(entry)}
                    className="flex w-full min-w-0 items-center gap-2 rounded-(--radius-control) px-2 py-1.5 text-left font-mono text-app-ui-sm text-foreground outline-none hover:bg-[var(--state-hover-bg)] aria-selected:bg-[var(--state-active-bg)]"
                  >
                    <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
      </form>

      {/* Path-not-found notice — inline + non-destructive: the directory list
          below keeps showing the last valid listing. */}
      {pathErrorHuman ? (
        <ErrorNotice message={pathErrorHuman} className="shrink-0 px-2 py-2" />
      ) : null}

      {/* Directory list — grows to fill the dialog's available height */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-(--radius-control) border border-border">
        {listLoading ? (
          // Loading: skeleton rows — no generic spinner
          <Skeleton
            label={t("sshPicker.loading_listing")}
            className="h-full gap-0 overflow-hidden px-0 py-0"
          >
            {(["psk-0", "psk-1", "psk-2", "psk-3", "psk-4", "psk-5"] as const).map((k) => (
              <SkeletonLine key={k} className="mx-2 my-1 h-8 rounded-(--radius-control)" />
            ))}
          </Skeleton>
        ) : browseErrorHuman ? (
          // Error: inline card within 240px (height invariant)
          // Redundant encoding: icon + border + bg + fg color
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4">
            <ErrorNotice message={browseErrorHuman} className="w-full px-3 py-2" />
            {browseErrorKind === "session-expired" ? (
              <p className="text-center text-app-ui-sm text-muted-foreground">
                <button
                  type="button"
                  onClick={onBack}
                  className="underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                >
                  ‹ {t("action.back")}
                </button>{" "}
                {t("sshPicker.to_reconnect")}
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
                {t("action.retry")}
              </button>
            )}
          </div>
        ) : dirEntries.length === 0 ? (
          // Empty folder — current path is still a valid workspace root
          <div className="flex h-full items-center justify-center">
            <EmptyState
              tone="status"
              icon={<Folder className="size-5" aria-hidden="true" />}
              title={t("sshPicker.this_folder_empty")}
              className="py-4"
            />
          </div>
        ) : (
          // Directory list
          <ul className="app-scrollbar h-full overflow-y-auto py-1" aria-label={t("sshPicker.directory_listing")}>
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
                  {t("sshPicker.truncated")}
                </p>
              </li>
            ) : null}
          </ul>
        )}
      </div>

      {/* Add error — humanised, redundant encoding */}
      {addErrorHuman ? (
        <ErrorNotice message={addErrorHuman} className="shrink-0 px-2 py-2" />
      ) : null}
    </div>
  );
}
