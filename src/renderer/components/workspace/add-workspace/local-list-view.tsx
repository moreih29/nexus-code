import {
  AlertCircle,
  Folder,
  FolderOpen,
  FolderPlus,
  LoaderCircle,
  Server,
  Star,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ConnectionProfile, FolderBookmark } from "../../../../shared/types/entry-points";
import { ipcCall, ipcCallResult } from "../../../ipc/client";
import { Button } from "../../ui/button";
import { EmptyState } from "../../ui/empty-state";
import { Skeleton, SkeletonLine } from "../../ui/skeleton";
import {
  folderName,
  formatSshSecondaryLine,
  formatSshTooltip,
  humanizeSshError,
} from "./ssh-helpers";
import type { LocalListViewProps } from "./types";

// ---------------------------------------------------------------------------
// MainListView (LocalListView) — unified local + SSH bookmark list (T3)
// ---------------------------------------------------------------------------

const RECENT_MAX_DEFAULT = 5;

export function LocalListView({
  onWorkspaceCreated,
  onClose,
  onSshServerList,
  onNewConnectionPrefill,
}: LocalListViewProps): React.JSX.Element {
  const [bookmarks, setBookmarks] = useState<FolderBookmark[]>([]);
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAllRecent, setShowAllRecent] = useState(false);

  // Per-bookmark action phase: null = idle, "opening" = folder picker, bookmarkId = reconnecting
  const [activeBookmarkId, setActiveBookmarkId] = useState<string | null>(null);
  const [openingFolder, setOpeningFolder] = useState(false);

  // Inline error state: per-bookmark error
  const [errorBookmarkId, setErrorBookmarkId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorProfileId, setErrorProfileId] = useState<string | null>(null);

  const anyBusy = openingFolder || activeBookmarkId !== null;

  const load = useCallback((): (() => void) => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      ipcCall("folderBookmark", "list", undefined),
      ipcCall("connectionProfile", "list", undefined),
    ])
      .then(([bookmarkList, profileList]) => {
        if (cancelled) return;
        const sorted = [...bookmarkList].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
        setBookmarks(sorted);
        setProfiles(profileList);
      })
      .catch(() => {
        if (cancelled) return;
        setBookmarks([]);
        setProfiles([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return load();
  }, [load]);

  // ── Local bookmark open ───────────────────────────────────────────────────

  async function openLocalBookmark(bookmark: FolderBookmark & { kind: "local" }): Promise<void> {
    if (anyBusy) return;
    setActiveBookmarkId(bookmark.id);
    clearError();
    try {
      const meta = await ipcCall("workspace", "create", {
        location: { kind: "local", rootPath: bookmark.absPath },
      });
      await ipcCall("folderBookmark", "record", {
        id: bookmark.id,
        absPath: bookmark.absPath,
        label: bookmark.label ?? undefined,
        kind: "local",
      });
      await onWorkspaceCreated(meta);
      onClose();
    } catch (error) {
      setError(bookmark.id, error, null);
    } finally {
      setActiveBookmarkId(null);
    }
  }

  // ── SSH bookmark reconnect ─────────────────────────────────────────────────

  async function reconnectSshBookmark(bookmark: FolderBookmark & { kind: "ssh" }): Promise<void> {
    if (anyBusy) return;
    setActiveBookmarkId(bookmark.id);
    clearError();

    // Find the associated connection profile
    const profile = profiles.find((p) => p.id === bookmark.connectionProfileId);
    if (!profile) {
      setError(
        bookmark.id,
        new Error("Connection profile not found. It may have been deleted."),
        null,
      );
      setActiveBookmarkId(null);
      return;
    }

    try {
      // createAndConnect runs SSH auth *before* persisting the workspace, so a
      // cancelled or failed auth never creates an orphaned sidebar entry.
      const result = await ipcCallResult("workspace", "createAndConnect", {
        location: {
          kind: "ssh",
          host: profile.host,
          user: profile.user,
          port: profile.port,
          identityFile: profile.identityFile ?? undefined,
          authMode: (profile.authMode as "interactive" | "key-only") ?? "interactive",
          remotePath: bookmark.absPath,
        },
        // sshBrowseSessionId omitted — main opens a fresh ControlMaster
      });

      if (!result.ok) {
        // User cancelled the auth prompt — silently stop, no error banner.
        if (result.kind === "cancelled") return;
        // Typed SSH failure (wrong credentials, host unreachable, …).
        setError(bookmark.id, new Error(result.message), profile.id);
        return;
      }

      // Update last_used_at
      await ipcCall("folderBookmark", "record", {
        id: bookmark.id,
        absPath: bookmark.absPath,
        label: bookmark.label ?? undefined,
        kind: "ssh",
        connectionProfileId: bookmark.connectionProfileId,
      });
      await onWorkspaceCreated(result.value);
      onClose();
    } catch (error) {
      setError(bookmark.id, error, profile.id);
    } finally {
      setActiveBookmarkId(null);
    }
  }

  // ── Folder picker ─────────────────────────────────────────────────────────

  async function openFolderPicker(): Promise<void> {
    if (anyBusy) return;
    setOpeningFolder(true);
    clearError();
    try {
      const { canceled, filePaths } = await ipcCall("dialog", "showOpenDirectory", {
        title: "Select workspace folder",
      });
      if (canceled || !filePaths[0]) {
        setOpeningFolder(false);
        return;
      }
      const absPath = filePaths[0];
      const meta = await ipcCall("workspace", "create", {
        location: { kind: "local", rootPath: absPath },
      });
      await ipcCall("folderBookmark", "record", {
        id: crypto.randomUUID(),
        absPath,
        kind: "local",
      });
      await onWorkspaceCreated(meta);
      onClose();
    } catch (error) {
      setError(null, error, null);
    } finally {
      setOpeningFolder(false);
    }
  }

  // ── Favorites / remove ────────────────────────────────────────────────────

  async function toggleFavorite(bookmark: FolderBookmark, event: React.MouseEvent): Promise<void> {
    event.stopPropagation();
    try {
      await ipcCall("folderBookmark", "setFavorite", {
        id: bookmark.id,
        favorite: !bookmark.favorite,
      });
      setBookmarks((prev) =>
        prev.map((b) => (b.id === bookmark.id ? { ...b, favorite: !b.favorite } : b)),
      );
    } catch {
      // silent — restored on next load
    }
  }

  async function removeBookmark(bookmark: FolderBookmark, event: React.MouseEvent): Promise<void> {
    event.stopPropagation();
    try {
      await ipcCall("folderBookmark", "remove", { id: bookmark.id });
      setBookmarks((prev) => prev.filter((b) => b.id !== bookmark.id));
      if (errorBookmarkId === bookmark.id) clearError();
    } catch {
      // silent
    }
  }

  // ── Error helpers ─────────────────────────────────────────────────────────

  function setError(bookmarkId: string | null, error: unknown, profileId: string | null): void {
    setErrorBookmarkId(bookmarkId);
    // SSH reconnect failures (profileId set) are humanised so raw SshErrorCode
    // strings never reach the UI; local failures keep a generic message.
    setErrorMessage(
      profileId !== null
        ? humanizeSshError(error)
        : error instanceof Error
          ? error.message
          : "Could not open workspace.",
    );
    setErrorProfileId(profileId);
  }

  function clearError(): void {
    setErrorBookmarkId(null);
    setErrorMessage(null);
    setErrorProfileId(null);
  }

  // ── Derived lists ─────────────────────────────────────────────────────────

  const favorites = bookmarks.filter((b) => b.favorite);
  const recents = bookmarks.filter((b) => !b.favorite);
  const visibleRecents = showAllRecent ? recents : recents.slice(0, RECENT_MAX_DEFAULT);
  const hasContent = bookmarks.length > 0;

  // ── Render helpers ────────────────────────────────────────────────────────

  function handleOpen(bookmark: FolderBookmark): void {
    if (bookmark.kind === "local") {
      void openLocalBookmark(bookmark);
    } else {
      void reconnectSshBookmark(bookmark);
    }
  }

  // ── Loading skeleton ──────────────────────────────────────────────────────

  if (loading) {
    return (
      <Skeleton label="Loading workspaces" className="gap-1 px-0 py-0">
        {(["sk-0", "sk-1", "sk-2", "sk-3"] as const).map((k) => (
          <SkeletonLine key={k} className="h-10 w-full" />
        ))}
      </Skeleton>
    );
  }

  // ── Global (non-bookmark) error ───────────────────────────────────────────

  const globalErrorBanner =
    errorBookmarkId === null && errorMessage ? (
      <ErrorBanner message={errorMessage} profileId={null} onSettings={null} />
    ) : null;

  // ── Empty state ───────────────────────────────────────────────────────────

  if (!hasContent) {
    return (
      <div className="flex flex-col gap-3">
        <ActionButtons
          busy={anyBusy}
          openingFolder={openingFolder}
          onOpenFolder={() => void openFolderPicker()}
          onSshServerList={onSshServerList}
        />
        {globalErrorBanner}
        <EmptyState
          tone="status"
          icon={<FolderPlus className="size-6" aria-hidden="true" />}
          title="No workspaces yet"
          description="Open a folder or connect via SSH to get started."
        />
      </div>
    );
  }

  // ── Main list ─────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-3">
      <ActionButtons
        busy={anyBusy}
        openingFolder={openingFolder}
        onOpenFolder={() => void openFolderPicker()}
        onSshServerList={onSshServerList}
      />

      {globalErrorBanner}

      <div className="flex flex-col gap-1">
        {favorites.length > 0 ? (
          <section aria-label="Favorites">
            <div className="px-2 pb-1 pt-0">
              <span className="text-app-label uppercase text-muted-foreground">Favorites</span>
            </div>
            <ul className="flex flex-col gap-0.5">
              {favorites.map((bookmark) => (
                <BookmarkRow
                  key={bookmark.id}
                  bookmark={bookmark}
                  profile={
                    bookmark.kind === "ssh"
                      ? (profiles.find((p) => p.id === bookmark.connectionProfileId) ?? null)
                      : null
                  }
                  disabled={anyBusy}
                  reconnecting={activeBookmarkId === bookmark.id}
                  error={errorBookmarkId === bookmark.id ? errorMessage : null}
                  errorProfileId={errorBookmarkId === bookmark.id ? errorProfileId : null}
                  onOpen={() => handleOpen(bookmark)}
                  onToggleFavorite={(e) => void toggleFavorite(bookmark, e)}
                  onRemove={(e) => void removeBookmark(bookmark, e)}
                  onOpenSettings={(pid) => onNewConnectionPrefill(pid)}
                />
              ))}
            </ul>
          </section>
        ) : null}

        {recents.length > 0 ? (
          <section aria-label="Recent" className={favorites.length > 0 ? "mt-3" : undefined}>
            <div className="px-2 pb-1 pt-0">
              <span className="text-app-label uppercase text-muted-foreground">Recent</span>
            </div>
            <ul className="flex flex-col gap-0.5">
              {visibleRecents.map((bookmark) => (
                <BookmarkRow
                  key={bookmark.id}
                  bookmark={bookmark}
                  profile={
                    bookmark.kind === "ssh"
                      ? (profiles.find((p) => p.id === bookmark.connectionProfileId) ?? null)
                      : null
                  }
                  disabled={anyBusy}
                  reconnecting={activeBookmarkId === bookmark.id}
                  error={errorBookmarkId === bookmark.id ? errorMessage : null}
                  errorProfileId={errorBookmarkId === bookmark.id ? errorProfileId : null}
                  onOpen={() => handleOpen(bookmark)}
                  onToggleFavorite={(e) => void toggleFavorite(bookmark, e)}
                  onRemove={(e) => void removeBookmark(bookmark, e)}
                  onOpenSettings={(pid) => onNewConnectionPrefill(pid)}
                />
              ))}
            </ul>
            {recents.length > RECENT_MAX_DEFAULT ? (
              <button
                type="button"
                onClick={() => setShowAllRecent((prev) => !prev)}
                className="mt-1 w-full rounded-(--radius-control) px-2 py-2 text-left text-app-ui-sm text-muted-foreground outline-none hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              >
                {showAllRecent ? "Show less" : `Show ${recents.length - RECENT_MAX_DEFAULT} more`}
              </button>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ActionButtons — top row with Open Folder + Connect via SSH
// ---------------------------------------------------------------------------

interface ActionButtonsProps {
  readonly busy: boolean;
  readonly openingFolder: boolean;
  readonly onOpenFolder: () => void;
  readonly onSshServerList: () => void;
}

function ActionButtons({
  busy,
  openingFolder,
  onOpenFolder,
  onSshServerList,
}: ActionButtonsProps): React.JSX.Element {
  return (
    <div className="flex gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={onOpenFolder}
        className="flex-1"
      >
        {openingFolder ? (
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <FolderOpen className="size-4" aria-hidden="true" />
        )}
        {openingFolder ? "Opening…" : "Open Folder…"}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={onSshServerList}
        className="flex-1"
      >
        <Server className="size-4" aria-hidden="true" />
        Connect via SSH…
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ErrorBanner — inline error with optional "Open connection settings" CTA
// ---------------------------------------------------------------------------

interface ErrorBannerProps {
  readonly message: string;
  readonly profileId: string | null;
  readonly onSettings: ((profileId: string) => void) | null;
}

function ErrorBanner({ message, profileId, onSettings }: ErrorBannerProps): React.JSX.Element {
  return (
    <div
      className="flex flex-col gap-2 rounded-(--radius-control) border border-[var(--state-error-border)] bg-[var(--state-error-bg)] px-3 py-2"
      role="alert"
    >
      <div className="flex items-start gap-2">
        <AlertCircle
          className="mt-0.5 size-4 shrink-0 text-[var(--state-error-fg)]"
          aria-hidden="true"
        />
        <span className="min-w-0 text-app-ui-sm text-[var(--state-error-fg)]">{message}</span>
      </div>
      {profileId && onSettings ? (
        <button
          type="button"
          onClick={() => onSettings(profileId)}
          className="self-start rounded-(--radius-control) text-app-ui-sm text-[var(--state-error-fg)] underline underline-offset-2 outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        >
          Open connection settings
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BookmarkRow — single unified bookmark row (local or SSH)
// ---------------------------------------------------------------------------

interface BookmarkRowProps {
  readonly bookmark: FolderBookmark;
  /** Resolved connection profile for SSH bookmarks; null for local. */
  readonly profile: ConnectionProfile | null;
  readonly disabled: boolean;
  readonly reconnecting: boolean;
  readonly error: string | null;
  readonly errorProfileId: string | null;
  readonly onOpen: () => void;
  readonly onToggleFavorite: (event: React.MouseEvent) => void;
  readonly onRemove: (event: React.MouseEvent) => void;
  readonly onOpenSettings: (profileId: string) => void;
}

function BookmarkRow({
  bookmark,
  profile,
  disabled,
  reconnecting,
  error,
  errorProfileId,
  onOpen,
  onToggleFavorite,
  onRemove,
  onOpenSettings,
}: BookmarkRowProps): React.JSX.Element {
  const isFavorite = bookmark.favorite;
  const isLocal = bookmark.kind === "local";

  // Primary display line: for SSH, show the remote folder leaf name (last path segment).
  // For local, use label if set, otherwise derive folder name from the absolute path.
  const displayName = isLocal
    ? (bookmark.label ?? folderName(bookmark.absPath))
    : folderName(bookmark.absPath);

  // Second line: local = full absPath, SSH = user@host (port omitted — full path in tooltip)
  let pathDisplay = bookmark.absPath;
  // Title tooltip — full details for both local and SSH
  let titleTooltip = bookmark.absPath;
  if (!isLocal && profile) {
    pathDisplay = formatSshSecondaryLine({ user: profile.user, host: profile.host });
    titleTooltip = formatSshTooltip({
      user: profile.user,
      host: profile.host,
      port: profile.port,
      remotePath: bookmark.absPath,
    });
  }

  return (
    <li>
      {/* Row: primary open-button + sibling action slot. The favorite/remove
          buttons are siblings (not descendants) of the row button — nesting a
          <button> inside a <button> is invalid HTML. */}
      <div
        className={`group flex items-center rounded-(--radius-control) hover:bg-[var(--state-hover-bg)]${
          disabled ? " pointer-events-none opacity-50" : ""
        }`}
      >
        <button
          type="button"
          disabled={disabled}
          onClick={onOpen}
          title={titleTooltip}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-(--radius-control) px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        >
          {/* Leading icon: Folder (local) or Server (ssh) */}
          {reconnecting ? (
            <LoaderCircle
              className="size-4 shrink-0 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
          ) : isLocal ? (
            <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <Server className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}

          {/* Name + path lines */}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-app-ui-sm text-foreground">{displayName}</span>
            <span className="block min-w-0 truncate text-app-micro text-[var(--editor-text-muted)]">
              {pathDisplay}
            </span>
          </span>
        </button>

        {/* Trailing action slot — sibling of the row button (see comment above).
            Always occupies fixed width to prevent layout shift on hover. At rest:
            only the star indicator icon is visible (opacity-100 on indicator,
            opacity-0 on buttons). On hover/focus: buttons fade in, indicator fades out. */}
        <span className="flex shrink-0 items-center pr-2">
          {/* At-rest star indicator — fades out on row hover/focus */}
          <span
            className="flex size-8 shrink-0 items-center justify-center text-muted-foreground transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
            aria-hidden="true"
          >
            {isFavorite ? <Star className="size-4" fill="currentColor" /> : null}
          </span>

          {/* Action buttons — always rendered, opacity-0 at rest to avoid layout shift */}
          <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              type="button"
              aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
              onClick={onToggleFavorite}
              tabIndex={-1}
              className="inline-flex size-8 items-center justify-center rounded-(--radius-control) text-muted-foreground outline-none pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            >
              <Star
                className="size-4"
                fill={isFavorite ? "currentColor" : "none"}
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              aria-label="Remove from list"
              onClick={onRemove}
              tabIndex={-1}
              className="inline-flex size-8 items-center justify-center rounded-(--radius-control) text-muted-foreground outline-none pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto hover:bg-[var(--state-hover-bg)] hover:text-[var(--state-error-fg)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </button>
          </span>
        </span>
      </div>

      {/* Per-bookmark inline error */}
      {error ? (
        <div className="px-2 pb-1">
          <ErrorBanner
            message={error}
            profileId={errorProfileId}
            onSettings={errorProfileId ? onOpenSettings : null}
          />
        </div>
      ) : null}
    </li>
  );
}
