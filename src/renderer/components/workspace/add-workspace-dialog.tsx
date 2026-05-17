import {
  AlertCircle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Folder,
  FolderOpen,
  LoaderCircle,
  Monitor,
  Plus,
  Server,
  Star,
  Trash2,
} from "lucide-react";
import { Dialog as RadixDialog } from "radix-ui";
import type { FormEvent, KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionProfile, FolderBookmark } from "../../../shared/types/entry-points";
import type { DirEntry } from "../../../shared/fs/types";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { ipcCall } from "../../ipc/client";
import type { CallReturn } from "../../ipc/types";
import { Button } from "../ui/button";
import { Skeleton, SkeletonLine } from "../ui/skeleton";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WorkspaceTab = "local" | "ssh";

/**
 * SSH 탭 내부 3-뷰 스택.
 *  connection-list  → 저장된 연결 목록 (기본 진입점)
 *  new-connection   → 새 SSH 연결 폼
 *  directory-picker → 원격 디렉터리 피커 (T9 구현)
 */
type SshView = "connection-list" | "new-connection" | "directory-picker";

/**
 * 루트 다이얼로그 phase — Local 전용 + idle.
 * SSH 연결 phase는 SshNewConnectionView 내부 상태로 분리.
 */
type DialogPhase = "idle" | "local-creating";

type SshConfigHost = CallReturn<"ssh", "listConfigHosts">[number];

/** last-used 탭을 sessionStorage에 유지한다 (세션 간 복원은 의도적으로 제외). */
const LAST_TAB_KEY = "addWorkspaceDialog.lastTab";

// ---------------------------------------------------------------------------
// View boundary interfaces — T7 구현 완료, T9가 채울 경계
// ---------------------------------------------------------------------------

/**
 * Local 탭 단일 목록 뷰 (T7 구현).
 */
export interface LocalListViewProps {
  readonly onWorkspaceCreated: (meta: WorkspaceMeta) => void | Promise<void>;
  readonly onClose: () => void;
}

/**
 * SSH 연결 목록 뷰 (T8 구현).
 */
export interface SshConnectionListViewProps {
  readonly onNewConnection: () => void;
  readonly onConnectProfile: (profile: ConnectionProfile) => void;
}

/**
 * SSH 새 연결 폼 뷰 (T8 구현).
 * 모든 상태를 뷰 내부에서 자가 관리 — 루트로 올리지 않음.
 */
export interface SshNewConnectionViewProps {
  /** 연결 성공 후 디렉터리 피커 뷰로 전이하기 위한 콜백. */
  readonly onConnected: (params: SshBrowseSession) => void;
  /** ~/.ssh/config 후보 목록 (이미 로드된 것을 상위에서 내려줌). */
  readonly configHosts: readonly SshConfigHost[];
  readonly configHostsLoading: boolean;
  /** 푸터 primary 버튼 상태를 루트로 올린다 — connectPhase와 connectDisabled. */
  readonly onConnectPhaseChange: (
    phase: "idle" | "connecting" | "error",
    disabled: boolean,
  ) => void;
}

/**
 * SSH 브라우즈 세션 정보 — openBrowseSession 성공 결과.
 * T9 디렉터리 피커에 전달된다.
 */
export interface SshBrowseSession {
  readonly sessionId: string;
  readonly initialPath: string;
  /** 연결에 사용한 host (display용). */
  readonly host: string;
  /** 연결에 사용한 user (display용, 없을 수 있음). */
  readonly user?: string;
  /** 저장용 connectionProfile id (record 호출 후 채워짐). */
  readonly profileId: string;
}

/**
 * SSH 디렉터리 피커 뷰 (T9 구현).
 */
export interface SshDirectoryPickerViewProps {
  readonly session: SshBrowseSession;
  readonly onWorkspaceCreated: (meta: WorkspaceMeta) => void | Promise<void>;
  /** 모달 닫기 — unmount cleanup이 closeBrowseSession을 처리한다. */
  readonly onClose: () => void;
  /** ‹ Back — 연결 목록 뷰 복귀. unmount 시 closeBrowseSession이 호출된다. */
  readonly onBack: () => void;
  /** 푸터 primary 버튼 상태를 루트로 올린다 — addPhase와 addDisabled. */
  readonly onAddPhaseChange: (phase: "idle" | "creating", disabled: boolean) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NEW_CONN_HOST_OPTIONS_ID = "add-workspace-new-conn-host-options";
const NEW_CONN_HOST_INPUT_ID = "add-workspace-new-conn-host";
const NEW_CONN_NAME_ID = "add-workspace-new-conn-name";
const NEW_CONN_PORT_ID = "add-workspace-new-conn-port";
const NEW_CONN_IDENTITY_FILE_ID = "add-workspace-new-conn-identity-file";
const NEW_CONN_PORT_ERROR_ID = "add-workspace-new-conn-port-error";
const NEW_CONN_ADVANCED_ID = "add-workspace-new-conn-advanced";
const TAB_PANEL_LOCAL_ID = "add-workspace-tab-panel-local";
const TAB_PANEL_SSH_ID = "add-workspace-tab-panel-ssh";
const TAB_TRIGGER_LOCAL_ID = "add-workspace-tab-trigger-local";
const TAB_TRIGGER_SSH_ID = "add-workspace-tab-trigger-ssh";

// ---------------------------------------------------------------------------
// Dialog props
// ---------------------------------------------------------------------------

export interface AddWorkspaceDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onWorkspaceCreated: (meta: WorkspaceMeta) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Root dialog component
// ---------------------------------------------------------------------------

export function AddWorkspaceDialog({
  open,
  onClose,
  onWorkspaceCreated,
}: AddWorkspaceDialogProps): React.JSX.Element {
  // ── Tab state — restored from sessionStorage ──────────────────────────────
  const [tab, setTab] = useState<WorkspaceTab>(() => {
    try {
      const stored = sessionStorage.getItem(LAST_TAB_KEY);
      return stored === "ssh" ? "ssh" : "local";
    } catch {
      return "local";
    }
  });

  // ── SSH 내부 3-뷰 상태 ────────────────────────────────────────────────────
  const [sshView, setSshView] = useState<SshView>("connection-list");

  // ── SSH browse session — openBrowseSession 성공 결과, 디렉터리 피커에 전달 ──
  const [browseSession, setBrowseSession] = useState<SshBrowseSession | null>(null);

  // ── SSH config hosts — 새 연결 폼 combobox에 쓰임 ─────────────────────────
  const [configHosts, setConfigHosts] = useState<SshConfigHost[]>([]);
  const [configHostsLoading, setConfigHostsLoading] = useState(false);

  // ── Local 전용 phase (SSH phase는 SshNewConnectionView 내부) ───────────────
  const [phase, setPhase] = useState<DialogPhase>("idle");

  // ── 푸터 primary 버튼 상태 — 각 폼 뷰에서 올려받음 ──────────────────────
  type ConnectPhase = "idle" | "connecting" | "error";
  const [connectPhase, setConnectPhase] = useState<ConnectPhase>("idle");
  const [connectDisabled, setConnectDisabled] = useState(true);
  const [addPhase, setAddPhase] = useState<"idle" | "creating">("idle");
  const [addDisabled, setAddDisabled] = useState(false);

  // ── Open effect — reset + load SSH config hosts ───────────────────────────
  useEffect(() => {
    if (!open) return;

    // Restore last-used tab; reset SSH view to connection-list
    try {
      const stored = sessionStorage.getItem(LAST_TAB_KEY);
      setTab(stored === "ssh" ? "ssh" : "local");
    } catch {
      setTab("local");
    }
    setSshView("connection-list");
    setBrowseSession(null);
    setPhase("idle");
    setConnectPhase("idle");
    setConnectDisabled(true);
    setAddPhase("idle");
    setAddDisabled(false);

    let cancelled = false;
    setConfigHostsLoading(true);
    ipcCall("ssh", "listConfigHosts", undefined)
      .then((list) => {
        if (cancelled) return;
        setConfigHosts(list);
      })
      .catch(() => {
        if (cancelled) return;
        setConfigHosts([]);
      })
      .finally(() => {
        if (!cancelled) setConfigHostsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  function closeAndAbort(): void {
    onClose();
  }

  function handleTabChange(next: WorkspaceTab): void {
    if (phase !== "idle") return;
    // 미저장 새 연결 폼에서 탭 전환 시 가드
    if (tab === "ssh" && sshView === "new-connection") {
      if (!window.confirm("Discard changes to the new connection?")) return;
    }
    setTab(next);
    try {
      sessionStorage.setItem(LAST_TAB_KEY, next);
    } catch {
      // sessionStorage unavailable — no-op
    }
  }

  // Connect 성공 콜백 — SshNewConnectionView에서 호출
  function handleConnected(session: SshBrowseSession): void {
    setBrowseSession(session);
    setConnectPhase("idle");
    setConnectDisabled(true);
    setAddPhase("idle");
    setAddDisabled(false);
    setSshView("directory-picker");
  }

  // 연결 목록 행 클릭 → 즉시 Connect 흐름
  // 연결 목록 뷰에서 바로 new-connection 폼으로 이동
  function handleNewConnection(): void {
    setConnectPhase("idle");
    setConnectDisabled(true);
    setSshView("new-connection");
  }

  // connectionProfile 행 클릭 → 새 연결 폼으로 이동하되 프로파일 정보를 pre-fill
  // (T8 구현: 목록에서 행 클릭하면 openBrowseSession 직접 호출)
  function handleConnectProfile(_profile: ConnectionProfile): void {
    // 연결 목록 뷰에서 직접 Connect 흐름은 SshConnectionListView 내부에서 처리
    // 여기서는 뷰 전이만 담당 — 실제 구현은 SshConnectionListView가 setBrowseSession 필요
    // 따라서 콜백으로 session을 올려받는다
  }

  // ── Primary button 계산 ──────────────────────────────────────────────────
  const busy = phase !== "idle";
  // 목록 뷰: primary 없음. 새 연결 폼: Connect. 디렉터리 피커: Add Workspace.
  let primarySlot: React.ReactNode = null;
  if (tab === "ssh" && sshView === "new-connection") {
    const isConnecting = connectPhase === "connecting";
    const isError = connectPhase === "error";
    primarySlot = (
      <Button
        type="submit"
        form="ssh-new-connection-form"
        size="sm"
        disabled={connectDisabled}
        className="min-w-[7.5rem]"
      >
        {isConnecting ? (
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <Server className="size-4" aria-hidden="true" />
        )}
        {isConnecting ? "Connecting…" : isError ? "Retry" : "Connect →"}
      </Button>
    );
  } else if (tab === "ssh" && sshView === "directory-picker") {
    primarySlot = (
      <Button
        type="button"
        size="sm"
        disabled={addDisabled}
        className="min-w-[9rem]"
        onClick={() => {
          document.getElementById("picker-add-workspace-trigger")?.click();
        }}
      >
        {addPhase === "creating" ? (
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <FolderOpen className="size-4" aria-hidden="true" />
        )}
        {addPhase === "creating" ? "Adding…" : "Add Workspace"}
      </Button>
    );
  }

  return (
    <RadixDialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeAndAbort();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <RadixDialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex w-[560px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[--radius-container] border border-border bg-background text-foreground shadow-none outline-none"
          style={{ minHeight: 480, maxHeight: "min(640px, 90vh)" }}
        >
          <RadixDialog.Title className="sr-only">Add Workspace</RadixDialog.Title>
          <RadixDialog.Description className="sr-only">
            Add a local or SSH workspace.
          </RadixDialog.Description>

          <div className="flex min-h-0 flex-1 flex-col">
            {/* ── Fixed header ──────────────────────────────────────────────── */}
            <DialogHeader
              tab={tab}
              sshView={sshView}
              busy={busy}
              onTabChange={handleTabChange}
              onBack={() => setSshView("connection-list")}
            />

            {/* ── Scrollable body ───────────────────────────────────────────── */}
            <div
              id={tab === "local" ? TAB_PANEL_LOCAL_ID : TAB_PANEL_SSH_ID}
              role="tabpanel"
              aria-labelledby={tab === "local" ? TAB_TRIGGER_LOCAL_ID : TAB_TRIGGER_SSH_ID}
              className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
            >
              <ViewBody
                tab={tab}
                sshView={sshView}
                browseSession={browseSession}
                onSshViewChange={setSshView}
                onWorkspaceCreated={onWorkspaceCreated}
                onClose={closeAndAbort}
                onConnected={handleConnected}
                onNewConnection={handleNewConnection}
                onConnectProfile={handleConnectProfile}
                configHosts={configHosts}
                configHostsLoading={configHostsLoading}
                onConnectPhaseChange={(phase, disabled) => {
                  setConnectPhase(phase);
                  setConnectDisabled(disabled);
                }}
                onAddPhaseChange={(phase, disabled) => {
                  setAddPhase(phase);
                  setAddDisabled(disabled);
                }}
              />
            </div>

            {/* ── Fixed footer ──────────────────────────────────────────────── */}
            <DialogFooter
              primarySlot={primarySlot}
              onCancel={closeAndAbort}
            />
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

// ---------------------------------------------------------------------------
// DialogHeader
// ---------------------------------------------------------------------------

interface DialogHeaderProps {
  readonly tab: WorkspaceTab;
  readonly sshView: SshView;
  readonly busy: boolean;
  readonly onTabChange: (tab: WorkspaceTab) => void;
  readonly onBack: () => void;
}

function DialogHeader({
  tab,
  sshView,
  busy,
  onTabChange,
  onBack,
}: DialogHeaderProps): React.JSX.Element {
  const showBack = tab === "ssh" && sshView !== "connection-list";

  return (
    <div className="shrink-0 border-b border-border px-5 pb-0 pt-5">
      {/* Title row */}
      <div className="flex min-h-[32px] items-center gap-2">
        {showBack ? (
          <button
            type="button"
            onClick={onBack}
            disabled={busy}
            aria-label="Back to connection list"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[--radius-control] text-muted-foreground outline-none hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
          </button>
        ) : null}
        <div>
          <div className="text-app-body-emphasis text-foreground">Add Workspace</div>
          <div className="text-app-ui-sm text-muted-foreground">{viewSubtitle(tab, sshView)}</div>
        </div>
      </div>

      {/* Tab bar — always visible */}
      <div
        role="tablist"
        aria-label="Workspace location"
        className="mt-3 inline-flex rounded-[--radius-control] border border-border bg-muted p-0.5"
      >
        <button
          id={TAB_TRIGGER_LOCAL_ID}
          type="button"
          role="tab"
          aria-selected={tab === "local"}
          aria-controls={TAB_PANEL_LOCAL_ID}
          disabled={busy}
          onClick={() => onTabChange("local")}
          className="inline-flex h-8 items-center gap-2 rounded-[--radius-control] px-3 text-app-ui-sm text-muted-foreground outline-none aria-selected:bg-background aria-selected:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
        >
          <FolderOpen className="size-4" aria-hidden="true" />
          Local
        </button>
        <button
          id={TAB_TRIGGER_SSH_ID}
          type="button"
          role="tab"
          aria-selected={tab === "ssh"}
          aria-controls={TAB_PANEL_SSH_ID}
          disabled={busy}
          onClick={() => onTabChange("ssh")}
          className="inline-flex h-8 items-center gap-2 rounded-[--radius-control] px-3 text-app-ui-sm text-muted-foreground outline-none aria-selected:bg-background aria-selected:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
        >
          <Server className="size-4" aria-hidden="true" />
          SSH
        </button>
      </div>

      <div className="h-0" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ViewBody — 뷰 라우팅 + FadeView
// ---------------------------------------------------------------------------

interface ViewBodyProps {
  readonly tab: WorkspaceTab;
  readonly sshView: SshView;
  readonly browseSession: SshBrowseSession | null;
  readonly onSshViewChange: (view: SshView) => void;
  readonly onWorkspaceCreated: (meta: WorkspaceMeta) => void | Promise<void>;
  readonly onClose: () => void;
  readonly onConnected: (session: SshBrowseSession) => void;
  readonly onNewConnection: () => void;
  readonly onConnectProfile: (profile: ConnectionProfile) => void;
  readonly configHosts: readonly SshConfigHost[];
  readonly configHostsLoading: boolean;
  readonly onConnectPhaseChange: (
    phase: "idle" | "connecting" | "error",
    disabled: boolean,
  ) => void;
  readonly onAddPhaseChange: (phase: "idle" | "creating", disabled: boolean) => void;
}

function ViewBody(props: ViewBodyProps): React.JSX.Element {
  const {
    tab,
    sshView,
    browseSession,
    onSshViewChange,
    onWorkspaceCreated,
    onClose,
    onConnected,
    onNewConnection,
    onConnectProfile,
    configHosts,
    configHostsLoading,
    onConnectPhaseChange,
    onAddPhaseChange,
  } = props;

  if (tab === "local") {
    return (
      <FadeView viewKey="local">
        <LocalListView onWorkspaceCreated={onWorkspaceCreated} onClose={onClose} />
      </FadeView>
    );
  }

  // SSH tab
  if (sshView === "connection-list") {
    return (
      <FadeView viewKey="ssh-connection-list">
        <SshConnectionListView
          onNewConnection={onNewConnection}
          onConnectProfile={onConnectProfile}
          onConnected={onConnected}
          onSshViewChange={onSshViewChange}
        />
      </FadeView>
    );
  }

  if (sshView === "new-connection") {
    return (
      <FadeView viewKey="ssh-new-connection">
        <SshNewConnectionView
          onConnected={onConnected}
          configHosts={configHosts}
          configHostsLoading={configHostsLoading}
          onConnectPhaseChange={onConnectPhaseChange}
        />
      </FadeView>
    );
  }

  // directory-picker — session이 null이면 연결 목록으로 복귀(방어)
  if (!browseSession) {
    return (
      <FadeView viewKey="ssh-connection-list">
        <SshConnectionListView
          onNewConnection={onNewConnection}
          onConnectProfile={onConnectProfile}
          onConnected={onConnected}
          onSshViewChange={onSshViewChange}
        />
      </FadeView>
    );
  }
  return (
    <FadeView viewKey="ssh-directory-picker">
      <SshDirectoryPickerView
        session={browseSession}
        onWorkspaceCreated={onWorkspaceCreated}
        onClose={onClose}
        onBack={() => onSshViewChange("connection-list")}
        onAddPhaseChange={onAddPhaseChange}
      />
    </FadeView>
  );
}

// ---------------------------------------------------------------------------
// FadeView — opacity transition respecting prefers-reduced-motion
// ---------------------------------------------------------------------------

interface FadeViewProps {
  readonly viewKey: string;
  readonly children: React.ReactNode;
}

function FadeView({ viewKey, children }: FadeViewProps): React.JSX.Element {
  const [visible, setVisible] = useState(false);
  const prevKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (prevKeyRef.current === viewKey) return;
    prevKeyRef.current = viewKey;

    const reducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reducedMotion) {
      setVisible(true);
      return;
    }

    setVisible(false);
    const raf = requestAnimationFrame(() => {
      setVisible(true);
    });
    return () => cancelAnimationFrame(raf);
  }, [viewKey]);

  return (
    <div
      style={{
        opacity: visible ? 1 : 0,
        transition: visible ? "opacity 200ms ease" : "none",
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DialogFooter — fixed, 4-rule layout
// ---------------------------------------------------------------------------

interface DialogFooterProps {
  /** Primary 슬롯 — null이면 빈 div로 레이아웃 유지 (R2). */
  readonly primarySlot: React.ReactNode;
  readonly onCancel: () => void;
}

function DialogFooter({ primarySlot, onCancel }: DialogFooterProps): React.JSX.Element {
  // R2: 항상 [secondary][primary] 2슬롯, 우측 정렬, 높이 고정 (h-16 = 64px)
  return (
    <div className="flex h-16 shrink-0 items-center justify-end gap-2 border-t border-border px-5">
      {/* Secondary slot — R3: 항상 Cancel */}
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>

      {/* Primary slot — 목록 뷰: 빈 div로 레이아웃 불변 보장. 폼 뷰: 실제 버튼. */}
      {primarySlot ?? <div className="min-w-[7.5rem]" aria-hidden="true" />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LocalListView — T7 구현
// ---------------------------------------------------------------------------

const RECENT_MAX_DEFAULT = 5;

function LocalListView({ onWorkspaceCreated, onClose }: LocalListViewProps): React.JSX.Element {
  const [bookmarks, setBookmarks] = useState<FolderBookmark[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAllRecent, setShowAllRecent] = useState(false);
  const [actionPhase, setActionPhase] = useState<"idle" | "opening" | "creating">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadBookmarks = useCallback((): (() => void) => {
    let cancelled = false;
    setLoading(true);
    ipcCall("folderBookmark", "list", undefined)
      .then((list) => {
        if (cancelled) return;
        const sorted = [...list].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
        setBookmarks(sorted);
      })
      .catch(() => {
        if (cancelled) return;
        setBookmarks([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return loadBookmarks();
  }, [loadBookmarks]);

  const favorites = bookmarks.filter((b) => b.favorite);
  const recents = bookmarks.filter((b) => !b.favorite);
  const visibleRecents = showAllRecent ? recents : recents.slice(0, RECENT_MAX_DEFAULT);
  const hasContent = bookmarks.length > 0;
  const busy = actionPhase !== "idle";

  async function openBookmark(bookmark: FolderBookmark): Promise<void> {
    if (busy) return;
    setActionPhase("creating");
    setErrorMessage(null);
    try {
      const meta = await ipcCall("workspace", "create", {
        location: { kind: "local", rootPath: bookmark.absPath },
      });
      await ipcCall("folderBookmark", "record", {
        id: bookmark.id,
        absPath: bookmark.absPath,
        label: bookmark.label ?? undefined,
      });
      await onWorkspaceCreated(meta);
      onClose();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not open workspace.");
      setActionPhase("idle");
    }
  }

  async function openFolderPicker(): Promise<void> {
    if (busy) return;
    setActionPhase("opening");
    setErrorMessage(null);
    try {
      const { canceled, filePaths } = await ipcCall("dialog", "showOpenDirectory", {
        title: "Select workspace folder",
      });
      if (canceled || !filePaths[0]) {
        setActionPhase("idle");
        return;
      }
      const absPath = filePaths[0];
      setActionPhase("creating");
      const meta = await ipcCall("workspace", "create", {
        location: { kind: "local", rootPath: absPath },
      });
      await ipcCall("folderBookmark", "record", {
        id: crypto.randomUUID(),
        absPath,
      });
      await onWorkspaceCreated(meta);
      onClose();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not add workspace.");
      setActionPhase("idle");
    }
  }

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
      // silent — 다음 load에서 복원됨
    }
  }

  async function removeBookmark(bookmark: FolderBookmark, event: React.MouseEvent): Promise<void> {
    event.stopPropagation();
    try {
      await ipcCall("folderBookmark", "remove", { id: bookmark.id });
      setBookmarks((prev) => prev.filter((b) => b.id !== bookmark.id));
    } catch {
      // silent
    }
  }

  if (loading) {
    return (
      <Skeleton label="Loading local workspaces" className="gap-1 px-0 py-0">
        {(["sk-0", "sk-1", "sk-2", "sk-3"] as const).map((k) => (
          <SkeletonLine key={k} className="h-10 w-full" />
        ))}
      </Skeleton>
    );
  }

  if (!hasContent) {
    return (
      <div className="flex flex-col items-center gap-4 py-8">
        <div className="flex flex-col items-center gap-2 text-center">
          <FolderOpen className="size-8 text-muted-foreground" aria-hidden="true" />
          <p className="text-app-ui-sm text-muted-foreground">
            No recent folders. Open a folder to get started.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => void openFolderPicker()}
        >
          {actionPhase === "opening" || actionPhase === "creating" ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <FolderOpen className="size-4" aria-hidden="true" />
          )}
          Open Folder…
        </Button>
        {errorMessage ? (
          <div
            className="flex items-start gap-2 rounded-[--radius-control] border border-destructive/60 bg-destructive/10 px-2 py-2 text-app-ui-sm text-destructive"
            role="alert"
          >
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0">{errorMessage}</span>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {errorMessage ? (
        <div
          className="mb-2 flex items-start gap-2 rounded-[--radius-control] border border-destructive/60 bg-destructive/10 px-2 py-2 text-app-ui-sm text-destructive"
          role="alert"
        >
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{errorMessage}</span>
        </div>
      ) : null}

      {favorites.length > 0 ? (
        <section aria-label="Favorites">
          <div className="px-2 pb-1 pt-0">
            <span className="text-app-label uppercase tracking-[2.4px] text-muted-foreground">
              Favorites
            </span>
          </div>
          <ul className="flex flex-col gap-0.5">
            {favorites.map((bookmark) => (
              <BookmarkRow
                key={bookmark.id}
                bookmark={bookmark}
                disabled={busy}
                onOpen={() => void openBookmark(bookmark)}
                onToggleFavorite={(e) => void toggleFavorite(bookmark, e)}
                onRemove={(e) => void removeBookmark(bookmark, e)}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {recents.length > 0 ? (
        <section aria-label="Recent" className={favorites.length > 0 ? "mt-3" : undefined}>
          <div className="px-2 pb-1 pt-0">
            <span className="text-app-label uppercase tracking-[2.4px] text-muted-foreground">
              Recent
            </span>
          </div>
          <ul className="flex flex-col gap-0.5">
            {visibleRecents.map((bookmark) => (
              <BookmarkRow
                key={bookmark.id}
                bookmark={bookmark}
                disabled={busy}
                onOpen={() => void openBookmark(bookmark)}
                onToggleFavorite={(e) => void toggleFavorite(bookmark, e)}
                onRemove={(e) => void removeBookmark(bookmark, e)}
              />
            ))}
          </ul>
          {recents.length > RECENT_MAX_DEFAULT ? (
            <button
              type="button"
              onClick={() => setShowAllRecent((prev) => !prev)}
              className="mt-1 w-full rounded-[--radius-control] px-2 py-1.5 text-left text-app-ui-sm text-muted-foreground outline-none hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
            >
              {showAllRecent ? "Show less" : `Show ${recents.length - RECENT_MAX_DEFAULT} more`}
            </button>
          ) : null}
        </section>
      ) : null}

      <div
        className={
          favorites.length > 0 || recents.length > 0 ? "mt-3 border-t border-border pt-3" : undefined
        }
      >
        <button
          type="button"
          disabled={busy}
          onClick={() => void openFolderPicker()}
          className="flex w-full items-center gap-3 rounded-[--radius-control] px-2 py-2 text-left text-app-ui-sm text-muted-foreground outline-none hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[--radius-control] border border-dashed border-border">
            {actionPhase === "opening" || actionPhase === "creating" ? (
              <LoaderCircle
                className="size-4 animate-spin text-muted-foreground"
                aria-hidden="true"
              />
            ) : (
              <FolderOpen className="size-4 text-muted-foreground" aria-hidden="true" />
            )}
          </span>
          <span className="min-w-0 truncate">Open Folder…</span>
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BookmarkRow — 단일 폴더 북마크 행 (LocalListView용)
// ---------------------------------------------------------------------------

interface BookmarkRowProps {
  readonly bookmark: FolderBookmark;
  readonly disabled: boolean;
  readonly onOpen: () => void;
  readonly onToggleFavorite: (event: React.MouseEvent) => void;
  readonly onRemove: (event: React.MouseEvent) => void;
}

function BookmarkRow({
  bookmark,
  disabled,
  onOpen,
  onToggleFavorite,
  onRemove,
}: BookmarkRowProps): React.JSX.Element {
  const displayName = bookmark.label ?? folderName(bookmark.absPath);
  const isFavorite = bookmark.favorite;

  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        onClick={onOpen}
        className="group flex w-full items-center gap-3 rounded-[--radius-control] px-2 py-1.5 text-left outline-none hover:bg-[var(--state-hover-bg)] focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
      >
        <FolderOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />

        <span className="min-w-0 flex-1">
          <span className="block truncate text-app-ui-sm text-foreground">{displayName}</span>
          <span className="block truncate text-app-ui-sm text-muted-foreground">
            {bookmark.absPath}
          </span>
        </span>

        {/* 액션 버튼들 — 44×44 hit area, stopPropagation */}
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
          <button
            type="button"
            aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
            onClick={onToggleFavorite}
            className="inline-flex size-11 items-center justify-center rounded-[--radius-control] text-muted-foreground outline-none hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Star className="size-4" fill={isFavorite ? "currentColor" : "none"} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Remove from list"
            onClick={onRemove}
            className="inline-flex size-11 items-center justify-center rounded-[--radius-control] text-muted-foreground outline-none hover:bg-[var(--state-hover-bg)] hover:text-destructive focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </button>
        </span>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// SshConnectionListView — T8 구현
// ---------------------------------------------------------------------------

interface SshConnectionListViewInternalProps extends SshConnectionListViewProps {
  readonly onConnected: (session: SshBrowseSession) => void;
  readonly onSshViewChange: (view: SshView) => void;
}

function SshConnectionListView({
  onNewConnection,
  onConnected,
}: SshConnectionListViewInternalProps): React.JSX.Element {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadProfiles = useCallback((): (() => void) => {
    let cancelled = false;
    setLoading(true);
    ipcCall("connectionProfile", "list", undefined)
      .then((list) => {
        if (cancelled) return;
        const sorted = [...list].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
        setProfiles(sorted);
      })
      .catch(() => {
        if (cancelled) return;
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
    return loadProfiles();
  }, [loadProfiles]);

  const favorites = profiles.filter((p) => p.favorite);
  const recents = profiles.filter((p) => !p.favorite);
  const hasContent = profiles.length > 0;
  const busy = connectingId !== null;

  async function connectProfile(profile: ConnectionProfile): Promise<void> {
    if (busy) return;
    setConnectingId(profile.id);
    setErrorId(null);
    setErrorMessage(null);
    try {
      const result = await ipcCall("ssh", "openBrowseSession", {
        host: profile.host,
        user: profile.user,
        port: profile.port,
        identityFile: profile.identityFile ?? undefined,
        authMode: profile.authMode as "interactive" | "key-only",
      });
      // 사용 기록 갱신
      await ipcCall("connectionProfile", "save", {
        id: profile.id,
        host: profile.host,
        user: profile.user,
        port: profile.port,
        identityFile: profile.identityFile ?? undefined,
        authMode: profile.authMode as "interactive" | "key-only",
        label: profile.label ?? undefined,
      });
      onConnected({
        sessionId: result.sessionId,
        initialPath: result.initialPath,
        host: profile.host,
        user: profile.user,
        profileId: profile.id,
      });
    } catch (error) {
      setErrorId(profile.id);
      setErrorMessage(error instanceof Error ? error.message : "Connection failed.");
    } finally {
      setConnectingId(null);
    }
  }

  async function toggleFavorite(
    profile: ConnectionProfile,
    event: React.MouseEvent,
  ): Promise<void> {
    event.stopPropagation();
    try {
      await ipcCall("connectionProfile", "setFavorite", {
        id: profile.id,
        favorite: !profile.favorite,
      });
      setProfiles((prev) =>
        prev.map((p) => (p.id === profile.id ? { ...p, favorite: !p.favorite } : p)),
      );
    } catch {
      // silent
    }
  }

  async function removeProfile(
    profile: ConnectionProfile,
    event: React.MouseEvent,
  ): Promise<void> {
    event.stopPropagation();
    try {
      await ipcCall("connectionProfile", "remove", { id: profile.id });
      setProfiles((prev) => prev.filter((p) => p.id !== profile.id));
    } catch {
      // silent
    }
  }

  if (loading) {
    return (
      <Skeleton label="Loading SSH connections" className="gap-1 px-0 py-0">
        {(["sk-0", "sk-1", "sk-2", "sk-3"] as const).map((k) => (
          <SkeletonLine key={k} className="h-10 w-full" />
        ))}
      </Skeleton>
    );
  }

  if (!hasContent) {
    return (
      <div className="flex flex-col items-center gap-4 py-8">
        <div className="flex flex-col items-center gap-2 text-center">
          <Server className="size-8 text-muted-foreground" aria-hidden="true" />
          <p className="text-app-ui-sm text-muted-foreground">
            No saved connections. Add a new connection to get started.
          </p>
        </div>
        <Button type="button" size="sm" onClick={onNewConnection}>
          <Plus className="size-4" aria-hidden="true" />
          New connection…
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {errorMessage && !errorId ? (
        <div
          className="mb-2 flex items-start gap-2 rounded-[--radius-control] border border-destructive/60 bg-destructive/10 px-2 py-2 text-app-ui-sm text-destructive"
          role="alert"
        >
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{errorMessage}</span>
        </div>
      ) : null}

      {favorites.length > 0 ? (
        <section aria-label="Favorites">
          <div className="px-2 pb-1 pt-0">
            <span className="text-app-label uppercase tracking-[2.4px] text-muted-foreground">
              Favorites
            </span>
          </div>
          <ul className="flex flex-col gap-0.5">
            {favorites.map((profile) => (
              <ConnectionProfileRow
                key={profile.id}
                profile={profile}
                connecting={connectingId === profile.id}
                disabled={busy}
                errorMessage={errorId === profile.id ? (errorMessage ?? undefined) : undefined}
                onConnect={() => void connectProfile(profile)}
                onToggleFavorite={(e) => void toggleFavorite(profile, e)}
                onRemove={(e) => void removeProfile(profile, e)}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {recents.length > 0 ? (
        <section aria-label="Recent" className={favorites.length > 0 ? "mt-3" : undefined}>
          <div className="px-2 pb-1 pt-0">
            <span className="text-app-label uppercase tracking-[2.4px] text-muted-foreground">
              Recent
            </span>
          </div>
          <ul className="flex flex-col gap-0.5">
            {recents.map((profile) => (
              <ConnectionProfileRow
                key={profile.id}
                profile={profile}
                connecting={connectingId === profile.id}
                disabled={busy}
                errorMessage={errorId === profile.id ? (errorMessage ?? undefined) : undefined}
                onConnect={() => void connectProfile(profile)}
                onToggleFavorite={(e) => void toggleFavorite(profile, e)}
                onRemove={(e) => void removeProfile(profile, e)}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {/* New connection 액션 행 */}
      <div
        className={
          hasContent ? "mt-3 border-t border-border pt-3" : undefined
        }
      >
        <button
          type="button"
          disabled={busy}
          onClick={onNewConnection}
          className="flex w-full items-center gap-3 rounded-[--radius-control] px-2 py-2 text-left text-app-ui-sm text-muted-foreground outline-none hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[--radius-control] border border-dashed border-border">
            <Plus className="size-4 text-muted-foreground" aria-hidden="true" />
          </span>
          <span className="min-w-0 truncate">New connection…</span>
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConnectionProfileRow — 단일 SSH 연결 프로파일 행
// ---------------------------------------------------------------------------

interface ConnectionProfileRowProps {
  readonly profile: ConnectionProfile;
  readonly connecting: boolean;
  readonly disabled: boolean;
  readonly errorMessage: string | undefined;
  readonly onConnect: () => void;
  readonly onToggleFavorite: (event: React.MouseEvent) => void;
  readonly onRemove: (event: React.MouseEvent) => void;
}

function ConnectionProfileRow({
  profile,
  connecting,
  disabled,
  errorMessage,
  onConnect,
  onToggleFavorite,
  onRemove,
}: ConnectionProfileRowProps): React.JSX.Element {
  const displayName = profile.label ?? profile.host;
  const isFavorite = profile.favorite;
  const subtitle = formatProfileSubtitle(profile);

  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        onClick={onConnect}
        className="group flex w-full items-center gap-3 rounded-[--radius-control] px-2 py-1.5 text-left outline-none hover:bg-[var(--state-hover-bg)] focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
      >
        {/* Server icon or spinner */}
        {connecting ? (
          <LoaderCircle
            className="size-4 shrink-0 animate-spin text-muted-foreground"
            aria-hidden="true"
          />
        ) : (
          <Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}

        {/* 이름 + 연결 정보 */}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-app-ui-sm text-foreground">{displayName}</span>
          <span className="block truncate text-app-ui-sm text-muted-foreground">{subtitle}</span>
          {errorMessage ? (
            <span className="mt-0.5 block truncate text-app-ui-sm text-destructive">
              {errorMessage}
            </span>
          ) : null}
        </span>

        {/* Chevron + 액션 버튼들 */}
        <span className="flex shrink-0 items-center gap-0.5">
          <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              type="button"
              aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
              onClick={onToggleFavorite}
              className="inline-flex size-11 items-center justify-center rounded-[--radius-control] text-muted-foreground outline-none hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Star
                className="size-4"
                fill={isFavorite ? "currentColor" : "none"}
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              aria-label="Remove connection"
              onClick={onRemove}
              className="inline-flex size-11 items-center justify-center rounded-[--radius-control] text-muted-foreground outline-none hover:bg-[var(--state-hover-bg)] hover:text-destructive focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </button>
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </span>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// SshNewConnectionView — T8 구현
//   - Host combobox (ssh/config 후보 포함)
//   - Name (선택)
//   - Advanced collapsible (Port + Identity file)
//   - Remote path·Authentication fieldset 없음
//   - authMode 항상 "interactive"
//   - Connect → ssh.openBrowseSession → connectionProfile.save → onConnected
// ---------------------------------------------------------------------------

type SshConnectPhase = "idle" | "connecting" | "error";

function SshNewConnectionView({
  onConnected,
  configHosts,
  configHostsLoading,
  onConnectPhaseChange,
}: SshNewConnectionViewProps): React.JSX.Element {
  // ── Local form state ────────────────────────────────────────────────────
  const [hostInput, setHostInput] = useState("");
  const [selectedAlias, setSelectedAlias] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [port, setPort] = useState("");
  const [identityFile, setIdentityFile] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [hostListOpen, setHostListOpen] = useState(false);
  const [activeHostIndex, setActiveHostIndex] = useState(-1);
  const [connectPhase, setConnectPhase] = useState<SshConnectPhase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const filteredHosts = useMemo(
    () => filterSshConfigHosts(configHosts, hostInput),
    [configHosts, hostInput],
  );
  const selectedHost = useMemo(
    () => findSshConfigHost(configHosts, hostInput, selectedAlias),
    [configHosts, hostInput, selectedAlias],
  );

  const portError =
    port.trim().length > 0 && parseSshPort(port) === null ? "Port must be 1–65535." : null;

  const parsedDest = useMemo(() => {
    if (selectedHost) return { host: selectedHost.alias, user: selectedHost.user };
    return parseSshDestination(hostInput);
  }, [selectedHost, hostInput]);

  const hostEmpty = hostInput.trim().length === 0;
  const connectDisabled =
    connectPhase === "connecting" || hostEmpty || portError !== null;

  // 푸터 primary 버튼 상태 동기화
  useEffect(() => {
    onConnectPhaseChange(connectPhase, connectDisabled);
  }, [connectPhase, connectDisabled, onConnectPhaseChange]);

  useEffect(() => {
    if (!hostListOpen) return;
    setActiveHostIndex((cur) => clampHostIndex(cur, filteredHosts.length));
  }, [hostListOpen, filteredHosts.length]);

  function handleHostInputChange(value: string): void {
    setHostInput(value);
    setSelectedAlias(null);
    setErrorMessage(null);
    setHostListOpen(true);
    setActiveHostIndex(filteredHosts.length > 0 ? 0 : -1);
  }

  function handleSelectHost(host: SshConfigHost): void {
    setHostInput(host.alias);
    setSelectedAlias(host.alias);
    setPort(host.port ? String(host.port) : "");
    setIdentityFile(host.identityFile ?? "");
    setHostListOpen(false);
    setActiveHostIndex(-1);
    setErrorMessage(null);
  }

  function handleHostKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filteredHosts.length === 0) return;
      setHostListOpen(true);
      setActiveHostIndex((cur) => (cur + 1) % filteredHosts.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filteredHosts.length === 0) return;
      setHostListOpen(true);
      setActiveHostIndex((cur) => (cur <= 0 ? filteredHosts.length - 1 : cur - 1));
      return;
    }
    if (event.key === "Enter" && hostListOpen && activeHostIndex >= 0) {
      const host = filteredHosts[activeHostIndex];
      if (!host) return;
      event.preventDefault();
      handleSelectHost(host);
      return;
    }
    if (event.key === "Escape" && hostListOpen) {
      event.preventDefault();
      setHostListOpen(false);
      setActiveHostIndex(-1);
    }
  }

  async function handleConnect(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (connectDisabled) return;

    const dest = parsedDest;
    if (!dest) {
      setErrorMessage("Enter a valid host or user@host.");
      return;
    }

    const parsedPort = parseSshPort(port);
    if (parsedPort === null) {
      setErrorMessage("Port must be 1–65535.");
      return;
    }

    setConnectPhase("connecting");
    setErrorMessage(null);

    try {
      const result = await ipcCall("ssh", "openBrowseSession", {
        host: dest.host,
        user: dest.user,
        port: parsedPort,
        identityFile: identityFile.trim() || undefined,
        authMode: "interactive",
      });

      // 연결 성공 → connectionProfile 저장
      const profileId = crypto.randomUUID();
      await ipcCall("connectionProfile", "save", {
        id: profileId,
        host: dest.host,
        user: dest.user ?? "",
        port: parsedPort,
        identityFile: identityFile.trim() || undefined,
        authMode: "interactive",
        label: name.trim() || undefined,
      });

      onConnected({
        sessionId: result.sessionId,
        initialPath: result.initialPath,
        host: dest.host,
        user: dest.user,
        profileId,
      });
    } catch (error) {
      setConnectPhase("error");
      setErrorMessage(error instanceof Error ? error.message : "Connection failed.");
    }
  }

  const activeDescendant =
    hostListOpen && activeHostIndex >= 0
      ? sshHostOptionId(filteredHosts[activeHostIndex], activeHostIndex)
      : undefined;

  const connecting = connectPhase === "connecting";

  return (
    <form id="ssh-new-connection-form" className="flex flex-col gap-4" onSubmit={(e) => void handleConnect(e)}>
      {/* Error message */}
      {errorMessage ? (
        <div
          className="flex items-start gap-2 rounded-[--radius-control] border border-destructive/60 bg-destructive/10 px-2 py-2 text-app-ui-sm text-destructive"
          role="alert"
        >
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{errorMessage}</span>
        </div>
      ) : null}

      {/* Host combobox */}
      <div className="flex flex-col gap-2">
        <label htmlFor={NEW_CONN_HOST_INPUT_ID} className="text-app-ui-sm text-foreground">
          Host
        </label>
        <div className="relative">
          <div className="flex items-center gap-2">
            <input
              id={NEW_CONN_HOST_INPUT_ID}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={hostListOpen}
              aria-controls={NEW_CONN_HOST_OPTIONS_ID}
              aria-activedescendant={activeDescendant}
              value={hostInput}
              onChange={(e) => handleHostInputChange(e.currentTarget.value)}
              onFocus={() => {
                if (filteredHosts.length > 0) setHostListOpen(true);
              }}
              onKeyDown={handleHostKeyDown}
              disabled={connecting}
              placeholder="user@host or ~/.ssh/config alias"
              className="min-w-0 flex-1 rounded-[--radius-control] border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
            />
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={hostListOpen ? "Close SSH config hosts" : "Show SSH config hosts"}
              aria-expanded={hostListOpen}
              disabled={connecting || configHosts.length === 0}
              onClick={() => setHostListOpen((prev) => !prev)}
            >
              <ChevronDown className="size-4" aria-hidden="true" />
            </Button>
          </div>

          {hostListOpen && filteredHosts.length > 0 ? (
            <div
              id={NEW_CONN_HOST_OPTIONS_ID}
              role="listbox"
              className="absolute left-0 right-10 top-[calc(100%+4px)] z-10 max-h-44 overflow-y-auto rounded-[--radius-control] border border-border bg-popover p-1 text-popover-foreground shadow-none"
            >
              {filteredHosts.map((host, index) => (
                <button
                  key={host.alias}
                  id={sshHostOptionId(host, index)}
                  type="button"
                  role="option"
                  aria-selected={index === activeHostIndex}
                  className="flex w-full min-w-0 flex-col rounded-[--radius-control] px-2 py-2 text-left text-app-ui-sm hover:bg-[var(--state-hover-bg)] focus-visible:bg-[var(--state-hover-bg)] focus-visible:outline-none aria-selected:bg-[var(--state-active-bg)]"
                  onClick={() => handleSelectHost(host)}
                >
                  <span className="truncate text-foreground">{host.alias}</span>
                  <span className="flex items-center gap-1 truncate text-app-ui-sm text-muted-foreground">
                    {formatSshHostSummary(host)}
                    <span className="shrink-0 rounded-[--radius-control] bg-muted px-1 text-app-micro text-muted-foreground">
                      ~/.ssh/config
                    </span>
                  </span>
                </button>
              ))}
              {configHostsLoading ? (
                <div className="px-2 py-2 text-app-ui-sm text-muted-foreground">
                  Loading SSH config…
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {selectedHost ? (
          <p className="text-app-ui-sm text-muted-foreground">
            {formatSshHostSummary(selectedHost)}
          </p>
        ) : null}
      </div>

      {/* Name (optional) */}
      <div className="flex flex-col gap-2">
        <label htmlFor={NEW_CONN_NAME_ID} className="text-app-ui-sm text-foreground">
          Name
          <span className="ml-1 text-app-ui-sm text-muted-foreground">(optional)</span>
        </label>
        <input
          id={NEW_CONN_NAME_ID}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          disabled={connecting}
          placeholder="e.g. Production server"
          className="w-full rounded-[--radius-control] border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
        />
      </div>

      {/* Advanced collapsible */}
      <div className="rounded-[--radius-control] border border-border px-3 py-2">
        <button
          type="button"
          className="flex w-full items-center justify-between text-left text-app-ui-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          aria-expanded={advancedOpen}
          aria-controls={NEW_CONN_ADVANCED_ID}
          disabled={connecting}
          onClick={() => setAdvancedOpen((prev) => !prev)}
        >
          <span>Advanced</span>
          {advancedOpen ? (
            <ChevronDown className="size-4" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-4" aria-hidden="true" />
          )}
        </button>
        {advancedOpen ? (
          <div id={NEW_CONN_ADVANCED_ID} className="mt-3 grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-2">
              <label htmlFor={NEW_CONN_PORT_ID} className="text-app-ui-sm text-foreground">
                Port
              </label>
              <input
                id={NEW_CONN_PORT_ID}
                type="text"
                inputMode="numeric"
                value={port}
                onChange={(e) => setPort(e.currentTarget.value)}
                disabled={connecting}
                aria-invalid={portError ? true : undefined}
                aria-describedby={portError ? NEW_CONN_PORT_ERROR_ID : undefined}
                placeholder="22"
                className="w-full rounded-[--radius-control] border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 aria-invalid:border-destructive"
              />
              {portError ? (
                <p id={NEW_CONN_PORT_ERROR_ID} className="text-app-ui-sm text-destructive">
                  {portError}
                </p>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <label htmlFor={NEW_CONN_IDENTITY_FILE_ID} className="text-app-ui-sm text-foreground">
                Identity file
              </label>
              <input
                id={NEW_CONN_IDENTITY_FILE_ID}
                value={identityFile}
                onChange={(e) => setIdentityFile(e.currentTarget.value)}
                disabled={connecting}
                placeholder="~/.ssh/id_ed25519"
                className="w-full rounded-[--radius-control] border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
              />
            </div>
          </div>
        ) : null}
      </div>

    </form>
  );
}

// ---------------------------------------------------------------------------
// SshDirectoryPickerView — T9 구현
// ---------------------------------------------------------------------------

/** browseSession 에러 분류. */
type BrowseErrorKind = "session-expired" | "retryable" | null;

/** 캐시 엔트리 — hover 프리페치 결과를 저장. */
interface BrowseCacheEntry {
  readonly entries: readonly DirEntry[];
  readonly truncated: boolean;
}

// 세션 만료·연결 끊김 에러 코드 집합
const SESSION_FATAL_CODES = new Set([
  "ssh.session-expired",
  "ssh.connect-failed",
  "ssh.auth-failed",
]);

/** POSIX 경로 결합 — 마지막 세그먼트 추가. */
function joinPath(base: string, segment: string): string {
  const clean = base.endsWith("/") ? base : `${base}/`;
  return segment === ".." ? parentPath(base) : `${clean}${segment}`;
}

/** POSIX 상위 경로 반환. */
function parentPath(path: string): string {
  const clean = path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
  const idx = clean.lastIndexOf("/");
  if (idx <= 0) return "/";
  return clean.slice(0, idx);
}

/** IPC 에러에서 SSH 에러 코드를 추출한다. */
function extractSshErrorKind(error: unknown): BrowseErrorKind {
  if (!(error instanceof Error)) return "retryable";
  // IPC 에러 메시지에 "ssh.session-expired" 등의 코드가 포함되는 경우를 처리
  const msg = error.message;
  for (const code of SESSION_FATAL_CODES) {
    if (msg.includes(code)) return "session-expired";
  }
  return "retryable";
}

const PICKER_LIST_HEIGHT = 240; // px — 고정, 스펙 §항상 불변
const HOVER_PREFETCH_DELAY_MS = 150;

function SshDirectoryPickerView({
  session,
  onWorkspaceCreated,
  onClose,
  onBack,
  onAddPhaseChange,
}: SshDirectoryPickerViewProps): React.JSX.Element {
  const { sessionId, initialPath, host } = session;

  // ── 경로 상태 ─────────────────────────────────────────────────────────────
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [pathInput, setPathInput] = useState(initialPath);
  const pathInputRef = useRef<HTMLInputElement>(null);

  // ── 목록 상태 ─────────────────────────────────────────────────────────────
  const [entries, setEntries] = useState<readonly DirEntry[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [truncated, setTruncated] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [browseErrorKind, setBrowseErrorKind] = useState<BrowseErrorKind>(null);

  // ── Add Workspace 상태 ────────────────────────────────────────────────────
  const [addPhase, setAddPhase] = useState<"idle" | "creating">("idle");
  const [addError, setAddError] = useState<string | null>(null);

  // ── 프리페치 ─────────────────────────────────────────────────────────────
  const browseCache = useRef<Map<string, BrowseCacheEntry>>(new Map());
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverAbortRef = useRef<AbortController | null>(null);
  const inFlightAbortRef = useRef<AbortController | null>(null);

  // ── 목록 로드 ─────────────────────────────────────────────────────────────
  const loadPath = useCallback(
    async (path: string, abortSignal?: AbortSignal): Promise<void> => {
      // 캐시 히트
      const cached = browseCache.current.get(path);
      if (cached) {
        setCurrentPath(path);
        setPathInput(path);
        setEntries(cached.entries);
        setTruncated(cached.truncated);
        setBrowseError(null);
        setBrowseErrorKind(null);
        setListLoading(false);
        return;
      }

      setListLoading(true);
      setBrowseError(null);
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
        setBrowseError(null);
        setBrowseErrorKind(null);
      } catch (error) {
        if (abortSignal?.aborted) return;
        const kind = extractSshErrorKind(error);
        setBrowseError(
          error instanceof Error ? error.message : "Could not list directory.",
        );
        setBrowseErrorKind(kind);
      } finally {
        if (!abortSignal?.aborted) setListLoading(false);
      }
    },
    [sessionId],
  );

  // 초기 로드 — mount-only; initialPath and loadPath are stable for the view lifetime.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-only effect
  useEffect(() => {
    const controller = new AbortController();
    inFlightAbortRef.current = controller;
    void loadPath(initialPath, controller.signal).finally(() => {
      if (inFlightAbortRef.current === controller) inFlightAbortRef.current = null;
    });
    // 입력 포커스
    pathInputRef.current?.focus();
    return () => {
      controller.abort();
    };
  }, []);

  // ── 드릴다운 ─────────────────────────────────────────────────────────────
  function drillDown(segment: string): void {
    const targetPath = joinPath(currentPath, segment);

    // 낙관적 경로바 갱신
    setPathInput(targetPath);

    // 이전 in-flight 취소
    inFlightAbortRef.current?.abort();
    const controller = new AbortController();
    inFlightAbortRef.current = controller;

    // 비관적 목록: 이전 항목은 스켈레톤으로 대체
    setListLoading(true);
    setAddError(null);

    void loadPath(targetPath, controller.signal).finally(() => {
      if (inFlightAbortRef.current === controller) inFlightAbortRef.current = null;
    });
  }

  // ── 경로바 Enter ─────────────────────────────────────────────────────────
  function handlePathSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = pathInput.trim();
    if (!trimmed || trimmed === currentPath) return;

    inFlightAbortRef.current?.abort();
    const controller = new AbortController();
    inFlightAbortRef.current = controller;
    setListLoading(true);
    setAddError(null);

    void loadPath(trimmed, controller.signal).finally(() => {
      if (inFlightAbortRef.current === controller) inFlightAbortRef.current = null;
    });
  }

  // ── Hover 프리페치 ────────────────────────────────────────────────────────
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
          // 프리페치 실패는 무시 — 실제 클릭 시 재시도
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

  // ── Add Workspace ─────────────────────────────────────────────────────────
  async function handleAddWorkspace(): Promise<void> {
    if (addPhase === "creating" || browseError) return;
    setAddPhase("creating");
    setAddError(null);
    try {
      const meta = await ipcCall("workspace", "create", {
        location: {
          kind: "ssh",
          host,
          user: session.user,
          remotePath: currentPath,
          authMode: "interactive",
        },
      });
      // 세션 정리는 unmount cleanup(useEffect return)이 담당 — 여기서 별도 호출 불필요.
      await onWorkspaceCreated(meta);
      onClose();
    } catch (error) {
      setAddError(error instanceof Error ? error.message : "Could not create workspace.");
      setAddPhase("idle");
    }
  }

  // ── Back / 모달 닫기 시 세션 정리 ───────────────────────────────────────
  // Back 이동, 워크스페이스 추가 성공, 모달 닫기 — 어떤 경로로 unmount되든 여기서 정리.
  // handleAddWorkspace는 별도로 closeBrowseSession을 호출하지 않는다.
  // sessionId is stable for the lifetime of this view — cleanup runs once on unmount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-only cleanup
  useEffect(() => {
    return () => {
      ipcCall("ssh", "closeBrowseSession", { sessionId }).catch(() => {});
    };
  }, []);

  // 디렉터리만 필터 (symlink 포함)
  const dirEntries = entries;
  const isAtRoot = currentPath === "/" || currentPath === "";
  const addDisabled = addPhase === "creating" || browseErrorKind === "session-expired";

  // 푸터 primary 버튼 상태 동기화
  useEffect(() => {
    onAddPhaseChange(addPhase, addDisabled);
  }, [addPhase, addDisabled, onAddPhaseChange]);

  return (
    <div className="flex flex-col gap-3">
      {/* ── 경로바 ──────────────────────────────────────────────────────── */}
      <form onSubmit={handlePathSubmit} className="flex flex-col gap-1">
        <label
          htmlFor="picker-path-input"
          className="text-app-ui-sm text-foreground"
        >
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
            className="min-w-0 flex-1 rounded-[--radius-control] border border-border bg-background px-2 py-1 font-mono text-app-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          />
          {!isAtRoot ? (
            <button
              type="button"
              aria-label="Go to parent directory"
              onClick={() => drillDown("..")}
              disabled={listLoading || addPhase === "creating"}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[--radius-control] border border-border bg-background text-muted-foreground outline-none hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            >
              <ChevronUp className="size-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </form>

      {/* ── 고정 240px 디렉터리 목록 영역 ──────────────────────────────── */}
      <div
        style={{ height: PICKER_LIST_HEIGHT }}
        className="overflow-hidden rounded-[--radius-control] border border-border"
      >
        {listLoading ? (
          // 로딩: 스켈레톤 행 — generic 스피너 금지
          <Skeleton
            label="Loading directory listing"
            className="h-full gap-0 overflow-hidden px-0 py-0"
          >
            {(["psk-0", "psk-1", "psk-2", "psk-3", "psk-4", "psk-5"] as const).map((k) => (
              <SkeletonLine
                key={k}
                className="mx-2 my-1 h-8 rounded-[--radius-control]"
              />
            ))}
          </Skeleton>
        ) : browseError ? (
          // 에러: 240px 내 인라인 카드 (높이 불변)
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4">
            <div
              className="flex w-full items-start gap-2 rounded-[--radius-control] border border-destructive/60 bg-destructive/10 px-3 py-2 text-app-ui-sm text-destructive"
              role="alert"
            >
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0">{browseError}</span>
            </div>
            {browseErrorKind === "session-expired" ? (
              <p className="text-center text-app-ui-sm text-muted-foreground">
                The SSH session has expired. Use{" "}
                <button
                  type="button"
                  onClick={onBack}
                  className="underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
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
                className="text-app-ui-sm text-muted-foreground underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
              >
                Retry
              </button>
            )}
          </div>
        ) : dirEntries.length === 0 ? (
          // 빈 상태: 안내 — 현재 경로도 유효 루트로 사용 가능
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4">
            <Folder className="size-6 text-muted-foreground" aria-hidden="true" />
            <p className="text-center text-app-ui-sm text-muted-foreground">
              No subdirectories found.
              <br />
              You can still use this folder as a workspace root.
            </p>
          </div>
        ) : (
          // 목록
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
                  <Folder
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
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

      {/* ── Add error ──────────────────────────────────────────────────── */}
      {addError ? (
        <div
          className="flex items-start gap-2 rounded-[--radius-control] border border-destructive/60 bg-destructive/10 px-2 py-2 text-app-ui-sm text-destructive"
          role="alert"
        >
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{addError}</span>
        </div>
      ) : null}

      {/* 푸터 primary 버튼이 트리거하는 숨겨진 제출 버튼 */}
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function viewSubtitle(tab: WorkspaceTab, sshView: SshView): string {
  if (tab === "local") return "Create a workspace from a local folder.";
  if (sshView === "connection-list") return "Choose a saved connection or add a new one.";
  if (sshView === "new-connection") return "Enter SSH connection details.";
  return "Select a remote directory.";
}


/** 절대 경로의 마지막 세그먼트(폴더명)를 반환한다. */
function folderName(absPath: string): string {
  const clean = absPath.replace(/[\\/]+$/, "");
  const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

function formatProfileSubtitle(profile: ConnectionProfile): string {
  const userPrefix = profile.user ? `${profile.user}@` : "";
  const portSuffix = profile.port !== 22 ? `:${profile.port}` : "";
  return `${userPrefix}${profile.host}${portSuffix}`;
}

// ---------------------------------------------------------------------------
// Pure utility functions (exported for tests)
// ---------------------------------------------------------------------------

export function parseSshDestination(input: string): { host: string; user?: string } | null {
  const value = input.trim();
  if (!value) return null;
  const atIndex = value.lastIndexOf("@");
  if (atIndex > 0 && atIndex < value.length - 1) {
    const user = value.slice(0, atIndex).trim();
    const host = value.slice(atIndex + 1).trim();
    if (!host || hostHasWhitespace(host) || user.length === 0) return null;
    return { host, user };
  }
  if (value.includes("@")) return null;
  if (hostHasWhitespace(value)) return null;
  return { host: value };
}

export function parseSshPort(value: string): number | undefined | null {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!/^\d+$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65_535 ? port : null;
}

export function filterSshConfigHosts(
  hosts: readonly SshConfigHost[],
  query: string,
): SshConfigHost[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return hosts.slice(0, 8);
  return hosts
    .filter((host) =>
      [host.alias, host.host, host.user]
        .filter((value): value is string => typeof value === "string")
        .some((value) => value.toLowerCase().includes(normalized)),
    )
    .slice(0, 8);
}

export function findSshConfigHost(
  hosts: readonly SshConfigHost[],
  hostInput: string,
  selectedAlias: string | null,
): SshConfigHost | null {
  const alias = selectedAlias ?? hostInput.trim();
  if (!alias || alias.includes("@")) return null;
  return hosts.find((host) => host.alias === alias) ?? null;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function hostHasWhitespace(host: string): boolean {
  return /\s/.test(host);
}

function clampHostIndex(index: number, length: number): number {
  if (length === 0) return -1;
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}

function sshHostOptionId(host: SshConfigHost | undefined, index: number): string {
  return `${NEW_CONN_HOST_OPTIONS_ID}-${host?.alias.replace(/[^A-Za-z0-9_-]/g, "_") ?? "item"}-${index}`;
}

function formatSshHostSummary(host: SshConfigHost): string {
  const destination = host.host ?? host.alias;
  const userPrefix = host.user ? `${host.user}@` : "";
  const portSuffix = host.port ? `:${host.port}` : "";
  return `${userPrefix}${destination}${portSuffix}`;
}
