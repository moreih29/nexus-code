import {
  Folder,
  FolderOpen,
  FolderPlus,
  LoaderCircle,
  Server,
  SquareTerminal,
  Star,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConnectionProfile, FolderBookmark } from "../../../../shared/types/entry-points";
import { normaliseError } from "../../../hooks/use-ipc-action";
import { surfaceError } from "../../../services/error-surface/surface-error";
import {
  createLocalWorkspace,
  createSshWorkspace,
  fetchConnectionProfiles,
  listFolderBookmarks,
  listWslDistros,
  pickLocalDirectory,
  recordLocalBookmark,
  recordSshBookmark,
  removeFolderBookmark,
  setFolderBookmarkFavorite,
} from "../../../services/workspace";
import { isWindows } from "../../../utils/platform";
import { Button } from "../../ui/button";
import { EmptyState } from "../../ui/empty-state";
import { Skeleton, SkeletonLine } from "../../ui/skeleton";
import { ErrorNotice } from "./error-notice";
import { folderName, formatSshSecondaryLine, formatSshTooltip } from "./ssh-helpers";
import type { MainListViewProps } from "./types";

const RECENT_MAX_DEFAULT = 5;

export function MainListView({
  onWorkspaceCreated,
  onClose,
  onSshServerList,
  onWslDistroList,
  onNewConnectionPrefill,
}: MainListViewProps): React.JSX.Element {
  const { t } = useTranslation();
  const [bookmarks, setBookmarks] = useState<FolderBookmark[]>([]);
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAllRecent, setShowAllRecent] = useState(false);

  const [activeBookmarkId, setActiveBookmarkId] = useState<string | null>(null);
  const [openingFolder, setOpeningFolder] = useState(false);

  const [errorBookmarkId, setErrorBookmarkId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorProfileId, setErrorProfileId] = useState<string | null>(null);

  const anyBusy = openingFolder || activeBookmarkId !== null;

  const [hasWsl, setHasWsl] = useState(false);
  useEffect(() => {
    if (!isWindows()) return;
    let cancelled = false;
    listWslDistros()
      .then((distros) => {
        if (!cancelled) setHasWsl(distros.length > 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback((): (() => void) => {
    let cancelled = false;
    setLoading(true);
    Promise.all([listFolderBookmarks(), fetchConnectionProfiles()])
      .then(([bookmarkList, profileList]) => {
        if (cancelled) return;
        setBookmarks(bookmarkList);
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

  async function openLocalBookmark(bookmark: FolderBookmark & { kind: "local" }): Promise<void> {
    if (anyBusy) return;
    setActiveBookmarkId(bookmark.id);
    clearError();
    try {
      const meta = await createLocalWorkspace(bookmark.absPath);
      await recordLocalBookmark({
        id: bookmark.id,
        absPath: bookmark.absPath,
        label: bookmark.label ?? undefined,
      });
      await onWorkspaceCreated(meta);
      onClose();
    } catch (error) {
      setError(bookmark.id, error, null);
    } finally {
      setActiveBookmarkId(null);
    }
  }

  async function reconnectSshBookmark(bookmark: FolderBookmark & { kind: "ssh" }): Promise<void> {
    if (anyBusy) return;
    setActiveBookmarkId(bookmark.id);
    clearError();

    const profile = profiles.find((p) => p.id === bookmark.connectionProfileId);
    if (!profile) {
      showError(bookmark.id, t("workspace.profile_not_found"), null);
      setActiveBookmarkId(null);
      return;
    }

    try {
      const result = await createSshWorkspace({
        host: profile.host,
        user: profile.user,
        port: profile.port,
        identityFile: profile.identityFile ?? undefined,
        authMode: (profile.authMode as "interactive" | "key-only") ?? "interactive",
        remotePath: bookmark.absPath,
      });

      if (!result.ok) {
        setError(bookmark.id, result, profile.id);
        return;
      }

      await recordSshBookmark({
        id: bookmark.id,
        absPath: bookmark.absPath,
        label: bookmark.label ?? undefined,
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

  async function openFolderPicker(): Promise<void> {
    if (anyBusy) return;
    setOpeningFolder(true);
    clearError();
    try {
      const absPath = await pickLocalDirectory();
      if (!absPath) {
        setOpeningFolder(false);
        return;
      }
      const meta = await createLocalWorkspace(absPath);
      await recordLocalBookmark({ id: crypto.randomUUID(), absPath });
      await onWorkspaceCreated(meta);
      onClose();
    } catch (error) {
      setError(null, error, null);
    } finally {
      setOpeningFolder(false);
    }
  }

  async function toggleFavorite(bookmark: FolderBookmark, event: React.MouseEvent): Promise<void> {
    event.stopPropagation();
    try {
      await setFolderBookmarkFavorite(bookmark.id, !bookmark.favorite);
      setBookmarks((prev) =>
        prev.map((b) => (b.id === bookmark.id ? { ...b, favorite: !b.favorite } : b)),
      );
    } catch {}
  }

  async function removeBookmark(bookmark: FolderBookmark, event: React.MouseEvent): Promise<void> {
    event.stopPropagation();
    try {
      await removeFolderBookmark(bookmark.id);
      setBookmarks((prev) => prev.filter((b) => b.id !== bookmark.id));
      if (errorBookmarkId === bookmark.id) clearError();
    } catch {}
  }

  function setError(bookmarkId: string | null, error: unknown, profileId: string | null): void {
    const surface = surfaceError(normaliseError(error), { surface: "inline" });
    if (surface.surface === "inline") showError(bookmarkId, surface.userMessage, profileId);
  }

  function showError(bookmarkId: string | null, message: string, profileId: string | null): void {
    setErrorBookmarkId(bookmarkId);
    setErrorMessage(message);
    setErrorProfileId(profileId);
  }

  function clearError(): void {
    setErrorBookmarkId(null);
    setErrorMessage(null);
    setErrorProfileId(null);
  }

  const favorites = bookmarks.filter((b) => b.favorite);
  const recents = bookmarks.filter((b) => !b.favorite);
  const visibleRecents = showAllRecent ? recents : recents.slice(0, RECENT_MAX_DEFAULT);
  const hasContent = bookmarks.length > 0;

  function handleOpen(bookmark: FolderBookmark): void {
    if (bookmark.kind === "local") {
      void openLocalBookmark(bookmark);
    } else {
      void reconnectSshBookmark(bookmark);
    }
  }

  if (loading) {
    return (
      <Skeleton label={t("workspace.add_title")} className="gap-1 px-0 py-0">
        {(["sk-0", "sk-1", "sk-2", "sk-3"] as const).map((k) => (
          <SkeletonLine key={k} className="h-10 w-full" />
        ))}
      </Skeleton>
    );
  }

  const globalErrorBanner =
    errorBookmarkId === null && errorMessage ? (
      <ErrorBanner message={errorMessage} profileId={null} onSettings={null} />
    ) : null;

  if (!hasContent) {
    return (
      <div className="flex flex-col gap-3">
        <ActionButtons
          busy={anyBusy}
          openingFolder={openingFolder}
          onOpenFolder={() => void openFolderPicker()}
          onSshServerList={onSshServerList}
          onWslDistroList={hasWsl ? onWslDistroList : null}
        />
        {globalErrorBanner}
        <EmptyState
          tone="status"
          icon={<FolderPlus className="size-6" aria-hidden="true" />}
          title={t("workspace.no_recent_folders")}
          description={t("workspace.no_recent_folders_desc")}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ActionButtons
        busy={anyBusy}
        openingFolder={openingFolder}
        onOpenFolder={() => void openFolderPicker()}
        onSshServerList={onSshServerList}
        onWslDistroList={hasWsl ? onWslDistroList : null}
      />

      {globalErrorBanner}

      <div className="flex flex-col gap-1">
        {favorites.length > 0 ? (
          <section aria-label={t("workspace.favorites")}>
            <div className="px-2 pb-1 pt-0">
              <span className="text-app-label uppercase text-muted-foreground">
                {t("workspace.favorites")}
              </span>
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
          <section
            aria-label={t("workspace.recent")}
            className={favorites.length > 0 ? "mt-3" : undefined}
          >
            <div className="px-2 pb-1 pt-0">
              <span className="text-app-label uppercase text-muted-foreground">
                {t("workspace.recent")}
              </span>
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
                {showAllRecent
                  ? t("workspace.show_less")
                  : t("workspace.show_more", { count: recents.length - RECENT_MAX_DEFAULT })}
              </button>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}

interface ActionButtonsProps {
  readonly busy: boolean;
  readonly openingFolder: boolean;
  readonly onOpenFolder: () => void;
  readonly onSshServerList: () => void;
  readonly onWslDistroList: (() => void) | null;
}

function ActionButtons({
  busy,
  openingFolder,
  onOpenFolder,
  onSshServerList,
  onWslDistroList,
}: ActionButtonsProps): React.JSX.Element {
  const { t } = useTranslation();
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
        {openingFolder ? t("workspace.opening_folder") : t("workspace.open_folder")}
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
        {t("workspace.connect_ssh")}
      </Button>
      {onWslDistroList ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={onWslDistroList}
          className="flex-1"
        >
          <SquareTerminal className="size-4" aria-hidden="true" />
          {t("workspace.open_wsl")}
        </Button>
      ) : null}
    </div>
  );
}

interface ErrorBannerProps {
  readonly message: string;
  readonly profileId: string | null;
  readonly onSettings: ((profileId: string) => void) | null;
}

function ErrorBanner({ message, profileId, onSettings }: ErrorBannerProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <ErrorNotice message={message} className="px-3 py-2" iconSize="md">
      {profileId && onSettings ? (
        <button
          type="button"
          onClick={() => onSettings(profileId)}
          className="self-start rounded-(--radius-control) text-app-ui-sm text-[var(--state-error-fg)] underline underline-offset-2 outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        >
          {t("action.open_connection_settings")}
        </button>
      ) : null}
    </ErrorNotice>
  );
}

interface BookmarkRowProps {
  readonly bookmark: FolderBookmark;
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
  const { t } = useTranslation();
  const isFavorite = bookmark.favorite;
  const isLocal = bookmark.kind === "local";

  const displayName = isLocal
    ? (bookmark.label ?? folderName(bookmark.absPath))
    : folderName(bookmark.absPath);

  let pathDisplay = bookmark.absPath;
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

          <span className="min-w-0 flex-1">
            <span className="block truncate text-app-ui-sm text-foreground">{displayName}</span>
            <span className="block min-w-0 truncate text-app-micro text-[var(--editor-text-muted)]">
              {pathDisplay}
            </span>
          </span>
        </button>

        <span className="flex shrink-0 items-center pr-2">
          <span
            className="flex size-8 shrink-0 items-center justify-center text-muted-foreground transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
            aria-hidden="true"
          >
            {isFavorite ? <Star className="size-4" fill="currentColor" /> : null}
          </span>

          <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              type="button"
              aria-label={
                isFavorite ? t("workspace.remove_from_favorites") : t("workspace.add_to_favorites")
              }
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
              aria-label={t("workspace.remove_from_list")}
              onClick={onRemove}
              tabIndex={-1}
              className="inline-flex size-8 items-center justify-center rounded-(--radius-control) text-muted-foreground outline-none pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto hover:bg-[var(--state-hover-bg)] hover:text-[var(--state-error-fg)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </button>
          </span>
        </span>
      </div>

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
