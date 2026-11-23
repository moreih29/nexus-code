import { ArrowLeft, FolderOpen, LoaderCircle, Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConnectionProfile } from "../../../../shared/types/entry-points";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import { fetchConnectionProfiles, listSshConfigHosts } from "../../../services/workspace";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { DialogHeader } from "../../ui/dialog-header";
import { IconButton } from "../../ui/icon-button";
import { MainListView } from "./main-list-view";
import { SshConnectionListView } from "./ssh-connection-list-view";
import { type SshDirectoryPickerHandle, SshDirectoryPickerView } from "./ssh-directory-picker-view";
import { SshNewConnectionView } from "./ssh-new-connection-view";
import type { ModalView, SshBrowseSession, SshConfigHost, WslBrowseSession } from "./types";
import { WslDistroListView } from "./wsl-distro-list-view";

export interface AddWorkspaceDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onWorkspaceCreated: (meta: WorkspaceMeta) => void | Promise<void>;
}

export function AddWorkspaceDialog({
  open,
  onClose,
  onWorkspaceCreated,
}: AddWorkspaceDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  const [view, setView] = useState<ModalView>("main-list");

  const [browseSession, setBrowseSession] = useState<SshBrowseSession | WslBrowseSession | null>(
    null,
  );

  const [configHosts, setConfigHosts] = useState<SshConfigHost[]>([]);
  const [configHostsLoading, setConfigHostsLoading] = useState(false);

  const [prefillProfile, setPrefillProfile] = useState<ConnectionProfile | null>(null);

  type ConnectPhase = "idle" | "connecting" | "error";
  const [connectPhase, setConnectPhase] = useState<ConnectPhase>("idle");
  const [connectDisabled, setConnectDisabled] = useState(true);
  const [addPhase, setAddPhase] = useState<"idle" | "creating">("idle");
  const [addDisabled, setAddDisabled] = useState(false);
  const pickerRef = useRef<SshDirectoryPickerHandle>(null);
  const cancelConnectRef = useRef<(() => void) | null>(null);

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

  function closeAndAbort(): void {
    cancelConnectRef.current?.();
    onClose();
  }

  function handleConnected(session: SshBrowseSession): void {
    setBrowseSession(session);
    setConnectPhase("idle");
    setConnectDisabled(true);
    setAddPhase("idle");
    setAddDisabled(false);
    setView("ssh-directory-picker");
  }

  function handleWslConnected(session: WslBrowseSession): void {
    setBrowseSession(session);
    setAddPhase("idle");
    setAddDisabled(false);
    setView("wsl-directory-picker");
  }

  function handleNewConnection(): void {
    setPrefillProfile(null);
    setConnectPhase("idle");
    setConnectDisabled(true);
    setView("ssh-new-connection");
  }

  function handleNewConnectionPrefill(profileId: string): void {
    fetchConnectionProfiles()
      .then((profiles) => {
        const profile = profiles.find((p) => p.id === profileId) ?? null;
        setPrefillProfile(profile);
        setConnectPhase("idle");
        setConnectDisabled(true);
        setView("ssh-new-connection");
      })
      .catch(() => {
        setPrefillProfile(null);
        setConnectPhase("idle");
        setConnectDisabled(true);
        setView("ssh-new-connection");
      });
  }

  function handleBack(): void {
    if (view === "ssh-server-list") {
      setView("main-list");
    } else if (view === "ssh-new-connection") {
      cancelConnectRef.current?.();
      setPrefillProfile(null);
      setView("ssh-server-list");
    } else if (view === "ssh-directory-picker") {
      setView("ssh-server-list");
    } else if (view === "wsl-distro-list") {
      setView("main-list");
    } else if (view === "wsl-directory-picker") {
      setView("wsl-distro-list");
    }
  }

  const showBack = view !== "main-list";

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
  } else if (view === "ssh-directory-picker" || view === "wsl-directory-picker") {
    primarySlot = (
      <Button
        type="button"
        size="sm"
        disabled={addDisabled}
        className="min-w-[9rem]"
        onClick={() => {
          pickerRef.current?.submit();
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
      contentStyle={{ height: "min(640px, 90vh)" }}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <AddWorkspaceHeader view={view} showBack={showBack} onBack={handleBack} />

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
          <ViewBody
            view={view}
            pickerRef={pickerRef}
            cancelConnectRef={cancelConnectRef}
            browseSession={browseSession}
            prefillProfile={prefillProfile}
            onViewChange={setView}
            onWorkspaceCreated={onWorkspaceCreated}
            onClose={closeAndAbort}
            onConnected={handleConnected}
            onNewConnection={handleNewConnection}
            onNewConnectionPrefill={handleNewConnectionPrefill}
            onSshServerList={() => setView("ssh-server-list")}
            onWslDistroList={() => setView("wsl-distro-list")}
            onWslConnected={handleWslConnected}
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

        {primarySlot ? <DialogFooter primarySlot={primarySlot} /> : null}
      </div>
    </Dialog>
  );
}

interface AddWorkspaceHeaderProps {
  readonly view: ModalView;
  readonly showBack: boolean;
  readonly onBack: () => void;
}

function AddWorkspaceHeader({
  view,
  showBack,
  onBack,
}: AddWorkspaceHeaderProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <DialogHeader
      className="shrink-0 px-4 pb-3 pt-4"
      title={t("workspace.add_title")}
      description={viewSubtitle(view, t)}
      close
      leading={
        showBack ? (
          <IconButton label={t("action.back")} size="lg" onClick={onBack}>
            <ArrowLeft className="size-4" aria-hidden="true" />
          </IconButton>
        ) : null
      }
    />
  );
}

interface ViewBodyProps {
  readonly cancelConnectRef: React.RefObject<(() => void) | null>;
  readonly view: ModalView;
  readonly pickerRef: React.RefObject<SshDirectoryPickerHandle | null>;
  readonly browseSession: SshBrowseSession | WslBrowseSession | null;
  readonly prefillProfile: ConnectionProfile | null;
  readonly onViewChange: (view: ModalView) => void;
  readonly onWorkspaceCreated: (meta: WorkspaceMeta) => void | Promise<void>;
  readonly onClose: () => void;
  readonly onConnected: (session: SshBrowseSession) => void;
  readonly onNewConnection: () => void;
  readonly onNewConnectionPrefill: (profileId: string) => void;
  readonly onSshServerList: () => void;
  readonly onWslDistroList: () => void;
  readonly onWslConnected: (session: WslBrowseSession) => void;
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
    pickerRef,
    cancelConnectRef,
    browseSession,
    prefillProfile,
    onViewChange,
    onWorkspaceCreated,
    onClose,
    onConnected,
    onNewConnection,
    onNewConnectionPrefill,
    onSshServerList,
    onWslDistroList,
    onWslConnected,
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
          onWslDistroList={onWslDistroList}
          onNewConnectionPrefill={onNewConnectionPrefill}
        />
      </FadeView>
    );
  }

  if (
    view === "wsl-distro-list" ||
    (view === "wsl-directory-picker" && !(browseSession && "distro" in browseSession))
  ) {
    return (
      <FadeView viewKey="wsl-distro-list">
        <WslDistroListView onConnected={onWslConnected} />
      </FadeView>
    );
  }

  if (view === "ssh-server-list") {
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

  if (view === "ssh-new-connection") {
    return (
      <FadeView viewKey="ssh-new-connection">
        <SshNewConnectionView
          cancelConnectRef={cancelConnectRef}
          onConnected={onConnected}
          configHosts={configHosts}
          configHostsLoading={configHostsLoading}
          onConnectPhaseChange={onConnectPhaseChange}
          prefillProfile={prefillProfile}
        />
      </FadeView>
    );
  }

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

  const isWsl = "distro" in browseSession;
  return (
    <FadeView viewKey={view} fill>
      <SshDirectoryPickerView
        ref={pickerRef}
        session={browseSession}
        onWorkspaceCreated={onWorkspaceCreated}
        onClose={onClose}
        onBack={() => onViewChange(isWsl ? "wsl-distro-list" : "ssh-server-list")}
        onAddPhaseChange={onAddPhaseChange}
      />
    </FadeView>
  );
}

interface FadeViewProps {
  readonly viewKey: string;
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

interface DialogFooterProps {
  readonly primarySlot: React.ReactNode;
}

function DialogFooter({ primarySlot }: DialogFooterProps): React.JSX.Element {
  return (
    <div className="flex h-14 shrink-0 items-center justify-end gap-2 px-4">{primarySlot}</div>
  );
}

function viewSubtitle(view: ModalView, t: (key: string) => string): string {
  if (view === "main-list") return t("workspace.add_subtitle_main");
  if (view === "ssh-server-list") return t("workspace.add_subtitle_ssh_list");
  if (view === "ssh-new-connection") return t("workspace.add_subtitle_ssh_new");
  if (view === "wsl-distro-list") return t("workspace.add_subtitle_wsl_list");
  if (view === "wsl-directory-picker") return t("workspace.add_subtitle_wsl_picker");
  return t("workspace.add_subtitle_ssh_picker");
}
