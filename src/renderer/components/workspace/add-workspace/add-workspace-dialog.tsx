import { ArrowLeft, FolderOpen, LoaderCircle, Server } from "lucide-react";
import { Dialog as RadixDialog } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConnectionProfile } from "../../../../shared/types/entry-points";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import { fetchConnectionProfiles, listSshConfigHosts } from "../../../services/workspace";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { MainListView } from "./main-list-view";
import { SshConnectionListView } from "./ssh-connection-list-view";
import { SshDirectoryPickerView } from "./ssh-directory-picker-view";
import { SshNewConnectionView } from "./ssh-new-connection-view";
import type { ModalView, SshBrowseSession, SshConfigHost } from "./types";

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
  const { t } = useTranslation();
  // 4-view state machine
  const [view, setView] = useState<ModalView>("main-list");

  // SSH browse session — passed to directory picker
  const [browseSession, setBrowseSession] = useState<SshBrowseSession | null>(null);

  // SSH config hosts — for new connection form combobox
  const [configHosts, setConfigHosts] = useState<SshConfigHost[]>([]);
  const [configHostsLoading, setConfigHostsLoading] = useState(false);

  // Prefill profile — set when user clicks "Open connection settings" from reconnect failure
  const [prefillProfile, setPrefillProfile] = useState<ConnectionProfile | null>(null);

  // Footer primary button state — lifted from form views
  type ConnectPhase = "idle" | "connecting" | "error";
  const [connectPhase, setConnectPhase] = useState<ConnectPhase>("idle");
  const [connectDisabled, setConnectDisabled] = useState(true);
  const [addPhase, setAddPhase] = useState<"idle" | "creating">("idle");
  const [addDisabled, setAddDisabled] = useState(false);

  // Open effect — reset + load SSH config hosts
  useEffect(() => {
    if (!open) return;

    setView("main-list");
    setBrowseSession(null);
    setPrefillProfile(null);
    setConnectPhase("idle");
    setConnectDisabled(true);
    setAddPhase("idle");
    setAddDisabled(false);

    let cancelled = false;
    setConfigHostsLoading(true);
    listSshConfigHosts()
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

  // Handlers

  function closeAndAbort(): void {
    onClose();
  }

  // Connect success callback — from SshNewConnectionView
  function handleConnected(session: SshBrowseSession): void {
    setBrowseSession(session);
    setConnectPhase("idle");
    setConnectDisabled(true);
    setAddPhase("idle");
    setAddDisabled(false);
    setView("ssh-directory-picker");
  }

  // Go from connection list to new connection form (no prefill)
  function handleNewConnection(): void {
    setPrefillProfile(null);
    setConnectPhase("idle");
    setConnectDisabled(true);
    setView("ssh-new-connection");
  }

  // Navigate to new-connection form with a prefilled profile
  // Used when SSH reconnect fails and user clicks "Open connection settings"
  function handleNewConnectionPrefill(profileId: string): void {
    // Load profile from already-fetched configHosts won't help here;
    // the profile is loaded by LocalListView inline and passed back as an id.
    // We fetch it once here so we can pass the full object to SshNewConnectionView.
    fetchConnectionProfiles()
      .then((profiles) => {
        const profile = profiles.find((p) => p.id === profileId) ?? null;
        setPrefillProfile(profile);
        setConnectPhase("idle");
        setConnectDisabled(true);
        setView("ssh-new-connection");
      })
      .catch(() => {
        // Fall through with no prefill
        setPrefillProfile(null);
        setConnectPhase("idle");
        setConnectDisabled(true);
        setView("ssh-new-connection");
      });
  }

  // Back — one step back in the view stack
  function handleBack(): void {
    if (view === "ssh-server-list") {
      setView("main-list");
    } else if (view === "ssh-new-connection") {
      setPrefillProfile(null);
      setView("ssh-server-list");
    } else if (view === "ssh-directory-picker") {
      setView("ssh-server-list");
    }
  }

  // ← Back is visible on every SSH view; main-list is the root (no Back).
  // From ssh-server-list it returns to the initial local/main view.
  const showBack =
    view === "ssh-server-list" || view === "ssh-new-connection" || view === "ssh-directory-picker";

  // Footer primary slot — only on form views
  let primarySlot: React.ReactNode = null;
  if (view === "ssh-new-connection") {
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
        {isConnecting ? t("ssh.connecting") : isError ? t("action.retry") : t("action.connect")}
      </Button>
    );
  } else if (view === "ssh-directory-picker") {
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
        {addPhase === "creating" ? t("sshPicker.adding") : t("sshPicker.add_workspace")}
      </Button>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeAndAbort();
      }}
      size="lg"
      padded={false}
      className="flex flex-col overflow-hidden"
      // Definite height (not min/max) so the flex chain down to the directory
      // picker's list resolves — the list box gets a real height and scrolls
      // internally. A fixed height also removes the resize jump between views.
      contentStyle={{ height: "min(640px, 90vh)" }}
    >
      <RadixDialog.Title className="sr-only">{t("workspace.add_title")}</RadixDialog.Title>
      <RadixDialog.Description className="sr-only">
        {t("workspace.add_subtitle_local")}
      </RadixDialog.Description>

      <div className="flex min-h-0 flex-1 flex-col">
        {/* Fixed header */}
        <DialogHeader view={view} showBack={showBack} onBack={handleBack} />

        {/* Scrollable body — flex column so a view can fill the height
            (the directory picker grows its list into the available space). */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
          <ViewBody
            view={view}
            browseSession={browseSession}
            prefillProfile={prefillProfile}
            onViewChange={setView}
            onWorkspaceCreated={onWorkspaceCreated}
            onClose={closeAndAbort}
            onConnected={handleConnected}
            onNewConnection={handleNewConnection}
            onNewConnectionPrefill={handleNewConnectionPrefill}
            onSshServerList={() => setView("ssh-server-list")}
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

        {/* Fixed footer — only rendered when there's a primary action */}
        {primarySlot ? <DialogFooter primarySlot={primarySlot} /> : null}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// DialogHeader
// ---------------------------------------------------------------------------

interface DialogHeaderProps {
  readonly view: ModalView;
  readonly showBack: boolean;
  readonly onBack: () => void;
}

function DialogHeader({ view, showBack, onBack }: DialogHeaderProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="shrink-0 px-4 pb-3 pt-4">
      {/* Title row — ← Back on the left (intra-dialog navigation between the
          4 views), title alongside. Flat-first: no header rule and no X close
          button; Esc / outside-click / Cancel dismiss the dialog. The size-8
          placeholder keeps the title's left edge fixed when Back is hidden. */}
      <div className="flex items-center gap-2">
        {showBack ? (
          <button
            type="button"
            onClick={onBack}
            aria-label={t("action.back")}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-(--radius-control) text-muted-foreground outline-none hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
          </button>
        ) : (
          <div className="size-8 shrink-0" aria-hidden="true" />
        )}

        <div className="min-w-0 flex-1">
          <div className="text-app-body-emphasis text-foreground">{t("workspace.add_title")}</div>
          <div className="text-app-ui-sm text-muted-foreground">{viewSubtitle(view, t)}</div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ViewBody — view routing + FadeView
// ---------------------------------------------------------------------------

interface ViewBodyProps {
  readonly view: ModalView;
  readonly browseSession: SshBrowseSession | null;
  readonly prefillProfile: ConnectionProfile | null;
  readonly onViewChange: (view: ModalView) => void;
  readonly onWorkspaceCreated: (meta: WorkspaceMeta) => void | Promise<void>;
  readonly onClose: () => void;
  readonly onConnected: (session: SshBrowseSession) => void;
  readonly onNewConnection: () => void;
  readonly onNewConnectionPrefill: (profileId: string) => void;
  readonly onSshServerList: () => void;
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
    view,
    browseSession,
    prefillProfile,
    onViewChange,
    onWorkspaceCreated,
    onClose,
    onConnected,
    onNewConnection,
    onNewConnectionPrefill,
    onSshServerList,
    configHosts,
    configHostsLoading,
    onConnectPhaseChange,
    onAddPhaseChange,
  } = props;

  if (view === "main-list") {
    return (
      <FadeView viewKey="main-list">
        <MainListView
          onWorkspaceCreated={onWorkspaceCreated}
          onClose={onClose}
          onSshServerList={onSshServerList}
          onNewConnectionPrefill={onNewConnectionPrefill}
        />
      </FadeView>
    );
  }

  if (view === "ssh-server-list") {
    return (
      <FadeView viewKey="ssh-server-list">
        <SshConnectionListView
          onNewConnection={onNewConnection}
          onConnectProfile={() => {
            // Connection list view handles connect internally via onConnected
          }}
          onConnected={onConnected}
          onSshViewChange={onViewChange}
        />
      </FadeView>
    );
  }

  if (view === "ssh-new-connection") {
    return (
      <FadeView viewKey="ssh-new-connection">
        <SshNewConnectionView
          onConnected={onConnected}
          configHosts={configHosts}
          configHostsLoading={configHostsLoading}
          onConnectPhaseChange={onConnectPhaseChange}
          prefillProfile={prefillProfile}
        />
      </FadeView>
    );
  }

  // ssh-directory-picker — guard: if session is null, fall back to server list
  if (!browseSession) {
    return (
      <FadeView viewKey="ssh-server-list">
        <SshConnectionListView
          onNewConnection={onNewConnection}
          onConnectProfile={() => {}}
          onConnected={onConnected}
          onSshViewChange={onViewChange}
        />
      </FadeView>
    );
  }

  return (
    <FadeView viewKey="ssh-directory-picker" fill>
      <SshDirectoryPickerView
        session={browseSession}
        onWorkspaceCreated={onWorkspaceCreated}
        onClose={onClose}
        onBack={() => onViewChange("ssh-server-list")}
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
  /**
   * Lock the view to the dialog body's height (adds min-h-0 so the flex child
   * is constrained, not content-sized). The view then owns its own internal
   * scrolling — used by the directory picker so its path bar stays pinned and
   * only the folder list scrolls. Default false: the view grows to its content
   * and the dialog body scrolls as a whole.
   */
  readonly fill?: boolean;
  readonly children: React.ReactNode;
}

function FadeView({ viewKey, fill = false, children }: FadeViewProps): React.JSX.Element {
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
      className={fill ? "flex min-h-0 flex-1 flex-col" : "flex flex-1 flex-col"}
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
// DialogFooter — fixed, primary action only
// ---------------------------------------------------------------------------

interface DialogFooterProps {
  /** Primary slot — rendered only when non-null. */
  readonly primarySlot: React.ReactNode;
}

function DialogFooter({ primarySlot }: DialogFooterProps): React.JSX.Element {
  return (
    <div className="flex h-14 shrink-0 items-center justify-end gap-2 px-4">{primarySlot}</div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function viewSubtitle(view: ModalView, t: (key: string) => string): string {
  if (view === "main-list") return t("workspace.add_subtitle_local");
  if (view === "ssh-server-list") return t("workspace.add_subtitle_ssh_list");
  if (view === "ssh-new-connection") return t("workspace.add_subtitle_ssh_new");
  return t("workspace.add_subtitle_ssh_picker");
}
