import { ArrowLeft, FolderOpen, LoaderCircle, Server, X } from "lucide-react";
import { Dialog as RadixDialog } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import type { ConnectionProfile } from "../../../../shared/types/entry-points";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import { ipcCall } from "../../../ipc/client";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { LocalListView } from "./local-list-view";
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
    ipcCall("connectionProfile", "list", undefined)
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
    if (view === "ssh-new-connection") {
      setPrefillProfile(null);
      setView("ssh-server-list");
    } else if (view === "ssh-directory-picker") {
      setView("ssh-server-list");
    }
  }

  // ← Back is visible only on ssh-new-connection and ssh-directory-picker
  const showBack = view === "ssh-new-connection" || view === "ssh-directory-picker";

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
        {isConnecting ? "Connecting…" : isError ? "Retry" : "Connect →"}
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
        {addPhase === "creating" ? "Adding…" : "Add Workspace"}
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
      contentStyle={{ minHeight: 480, maxHeight: "min(640px, 90vh)" }}
    >
      <RadixDialog.Title className="sr-only">Add Workspace</RadixDialog.Title>
      <RadixDialog.Description className="sr-only">
        Add a local or SSH workspace.
      </RadixDialog.Description>

      <div className="flex min-h-0 flex-1 flex-col">
        {/* Fixed header */}
        <DialogHeader view={view} showBack={showBack} onBack={handleBack} onClose={closeAndAbort} />

        {/* Scrollable body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
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
  readonly onClose: () => void;
}

function DialogHeader({ view, showBack, onBack, onClose }: DialogHeaderProps): React.JSX.Element {
  return (
    <div className="shrink-0 border-b border-border px-5 pb-2 pt-3">
      {/* Title row — ← Back on left, title center-left, X on right.
          Back/Close buttons (size-8 = 32px) provide the hit target;
          py-2 on the wrapper gives sufficient vertical breathing room. */}
      <div className="flex items-center gap-2">
        {showBack ? (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-(--radius-control) text-muted-foreground outline-none hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
          </button>
        ) : (
          // Placeholder to keep title aligned when Back is hidden
          <div className="size-8 shrink-0" aria-hidden="true" />
        )}

        <div className="min-w-0 flex-1">
          <div className="text-app-body-emphasis text-foreground">Add Workspace</div>
          <div className="text-app-ui-sm text-muted-foreground">{viewSubtitle(view)}</div>
        </div>

        {/* X Close button — always visible */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-(--radius-control) text-muted-foreground outline-none hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
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
        <LocalListView
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
    <FadeView viewKey="ssh-directory-picker">
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
// DialogFooter — fixed, primary action only
// ---------------------------------------------------------------------------

interface DialogFooterProps {
  /** Primary slot — rendered only when non-null. */
  readonly primarySlot: React.ReactNode;
}

function DialogFooter({ primarySlot }: DialogFooterProps): React.JSX.Element {
  return (
    <div className="flex h-14 shrink-0 items-center justify-end gap-2 border-t border-border px-5">
      {primarySlot}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function viewSubtitle(view: ModalView): string {
  if (view === "main-list") return "Create a workspace from a local folder.";
  if (view === "ssh-server-list") return "Choose a saved connection or add a new one.";
  if (view === "ssh-new-connection") return "Enter SSH connection details.";
  return "Select a remote directory.";
}
