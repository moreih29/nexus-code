import type { ConnectionProfile } from "../../../../shared/types/entry-points";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import type { CallReturn } from "../../../ipc/types";

export type SshConfigHost = CallReturn<"ssh", "listConfigHosts">[number];

export type ModalView =
  | "main-list"
  | "ssh-server-list"
  | "ssh-new-connection"
  | "ssh-directory-picker"
  | "wsl-distro-list"
  | "wsl-directory-picker";

export interface SshBrowseSession {
  readonly sessionId: string;
  readonly initialPath: string;
  readonly host: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly profileId: string;
  readonly connectionProfileId: string;
}

export interface WslBrowseSession {
  readonly sessionId: string;
  readonly initialPath: string;
  readonly distro: string;
}

export interface MainListViewProps {
  readonly onWorkspaceCreated: (meta: WorkspaceMeta) => void | Promise<void>;
  readonly onClose: () => void;
  readonly onSshServerList: () => void;
  readonly onWslDistroList: () => void;
  readonly onNewConnectionPrefill: (profileId: string) => void;
}

export interface SshConnectionListViewProps {
  readonly onNewConnection: () => void;
  readonly onConnectProfile: (profile: ConnectionProfile) => void;
  readonly onConnected: (session: SshBrowseSession) => void;
  readonly onSshViewChange: (view: ModalView) => void;
}

export interface SshNewConnectionViewProps {
  readonly cancelConnectRef?: React.RefObject<(() => void) | null>;
  readonly onConnected: (params: SshBrowseSession) => void;
  readonly configHosts: readonly SshConfigHost[];
  readonly configHostsLoading: boolean;
  readonly onConnectPhaseChange: (
    phase: "idle" | "connecting" | "error",
    disabled: boolean,
  ) => void;
  readonly prefillProfile?: ConnectionProfile | null;
}

export interface SshDirectoryPickerViewProps {
  readonly session: SshBrowseSession | WslBrowseSession;
  readonly onWorkspaceCreated: (meta: WorkspaceMeta) => void | Promise<void>;
  readonly onClose: () => void;
  readonly onBack: () => void;
  readonly onAddPhaseChange: (phase: "idle" | "creating", disabled: boolean) => void;
}

export interface WslDistroListViewProps {
  readonly onConnected: (session: WslBrowseSession) => void;
}
