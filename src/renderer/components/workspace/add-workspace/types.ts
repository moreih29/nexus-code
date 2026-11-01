// ---------------------------------------------------------------------------
// Shared types for the Add Workspace modal split-file structure.
// ---------------------------------------------------------------------------

import type { ConnectionProfile } from "../../../../shared/types/entry-points";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import type { CallReturn } from "../../../ipc/types";

export type SshConfigHost = CallReturn<"ssh", "listConfigHosts">[number];

/**
 * View state machine for the Add Workspace modal.
 *  main-list        → Local folder list + SSH server list (default entry point)
 *  ssh-server-list  → SSH saved connection list (when SSH entry chosen)
 *  ssh-new-connection   → New SSH connection form
 *  ssh-directory-picker → Remote directory picker (after successful connect)
 *  wsl-distro-list      → WSL distributions (Windows, when WSL entry chosen)
 *  wsl-directory-picker → The directory picker on a WSL distribution
 */
export type ModalView =
  | "main-list"
  | "ssh-server-list"
  | "ssh-new-connection"
  | "ssh-directory-picker"
  | "wsl-distro-list"
  | "wsl-directory-picker";

/**
 * SSH browse session — openBrowseSession success result.
 * Passed to the directory picker view.
 */
export interface SshBrowseSession {
  readonly sessionId: string;
  readonly initialPath: string;
  /** Host used for the connection. */
  readonly host: string;
  /** User used for the connection (may be absent). */
  readonly user?: string;
  /** Port used for the connection — must be included in the workspace location. */
  readonly port?: number;
  /** Identity file used for the connection (may be absent). */
  readonly identityFile?: string;
  /** Saved connectionProfile id (populated after connectionProfile.save call). */
  readonly profileId: string;
  /**
   * Same as profileId — explicit alias used when recording the SSH folder bookmark.
   * folderBookmark.record requires connectionProfileId to link the ssh variant.
   */
  readonly connectionProfileId: string;
}

/**
 * WSL browse session — `wsl.openBrowseSession`'s result for one distribution.
 * The directory picker browses it like an SSH session.
 */
export interface WslBrowseSession {
  readonly sessionId: string;
  readonly initialPath: string;
  readonly distro: string;
}

// ---------------------------------------------------------------------------
// View boundary interfaces
// ---------------------------------------------------------------------------

/**
 * Main list view props.
 * Serves as the unified main-list view (local + SSH bookmarks).
 */
export interface MainListViewProps {
  readonly onWorkspaceCreated: (meta: WorkspaceMeta) => void | Promise<void>;
  readonly onClose: () => void;
  /** Navigate to ssh-server-list view ("Connect via SSH…" button). */
  readonly onSshServerList: () => void;
  /** Navigate to wsl-distro-list view ("Open WSL folder" button, Windows only). */
  readonly onWslDistroList: () => void;
  /**
   * Navigate to ssh-new-connection view, optionally pre-filling a profile.
   * Used when SSH reconnect fails and user clicks "Open connection settings".
   */
  readonly onNewConnectionPrefill: (profileId: string) => void;
}

/**
 * SSH connection list view props.
 */
export interface SshConnectionListViewProps {
  readonly onNewConnection: () => void;
  readonly onConnectProfile: (profile: ConnectionProfile) => void;
  readonly onConnected: (session: SshBrowseSession) => void;
  readonly onSshViewChange: (view: ModalView) => void;
}

/**
 * SSH new connection form view props.
 * All state is self-managed inside the view — not lifted to root.
 */
export interface SshNewConnectionViewProps {
  /** Callback after successful connect — transitions to directory picker. */
  readonly onConnected: (params: SshBrowseSession) => void;
  /** ~/.ssh/config candidate list (pre-loaded by parent). */
  readonly configHosts: readonly SshConfigHost[];
  readonly configHostsLoading: boolean;
  /** Lifts footer primary button state to root — connectPhase and connectDisabled. */
  readonly onConnectPhaseChange: (
    phase: "idle" | "connecting" | "error",
    disabled: boolean,
  ) => void;
  /**
   * Optional connection profile to prefill the form with.
   * Used when the user clicks "Open connection settings" after a reconnect failure.
   */
  readonly prefillProfile?: ConnectionProfile | null;
}

/**
 * Directory picker view props, for an SSH host or a WSL distribution.
 */
export interface SshDirectoryPickerViewProps {
  readonly session: SshBrowseSession | WslBrowseSession;
  readonly onWorkspaceCreated: (meta: WorkspaceMeta) => void | Promise<void>;
  /** Close modal — unmount cleanup handles closeBrowseSession. */
  readonly onClose: () => void;
  /** Back — return to connection list view. closeBrowseSession called on unmount. */
  readonly onBack: () => void;
  /** Lifts footer primary button state to root — addPhase and addDisabled. */
  readonly onAddPhaseChange: (phase: "idle" | "creating", disabled: boolean) => void;
}

/**
 * WSL distribution list view props.
 */
export interface WslDistroListViewProps {
  /** A distribution's agent is up — transitions to the directory picker. */
  readonly onConnected: (session: WslBrowseSession) => void;
}
