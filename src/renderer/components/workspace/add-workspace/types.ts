// ---------------------------------------------------------------------------
// Shared types for the Add Workspace modal split-file structure.
// ---------------------------------------------------------------------------

import type { ConnectionProfile } from "../../../../shared/types/entry-points";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import type { CallReturn } from "../../../ipc/types";

export type SshConfigHost = CallReturn<"ssh", "listConfigHosts">[number];

/**
 * 4-view state machine for the Add Workspace modal.
 *  main-list        → Local folder list + SSH server list (default entry point)
 *  ssh-server-list  → SSH saved connection list (when SSH entry chosen)
 *  ssh-new-connection   → New SSH connection form
 *  ssh-directory-picker → Remote directory picker (after successful connect)
 */
export type ModalView =
  | "main-list"
  | "ssh-server-list"
  | "ssh-new-connection"
  | "ssh-directory-picker";

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

// ---------------------------------------------------------------------------
// View boundary interfaces
// ---------------------------------------------------------------------------

/**
 * Local folder list view props.
 * Now serves as the unified main-list view (local + SSH bookmarks).
 */
export interface LocalListViewProps {
  readonly onWorkspaceCreated: (meta: WorkspaceMeta) => void | Promise<void>;
  readonly onClose: () => void;
  /** Navigate to ssh-server-list view ("Connect via SSH…" button). */
  readonly onSshServerList: () => void;
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
 * SSH directory picker view props.
 */
export interface SshDirectoryPickerViewProps {
  readonly session: SshBrowseSession;
  readonly onWorkspaceCreated: (meta: WorkspaceMeta) => void | Promise<void>;
  /** Close modal — unmount cleanup handles closeBrowseSession. */
  readonly onClose: () => void;
  /** Back — return to connection list view. closeBrowseSession called on unmount. */
  readonly onBack: () => void;
  /** Lifts footer primary button state to root — addPhase and addDisabled. */
  readonly onAddPhaseChange: (phase: "idle" | "creating", disabled: boolean) => void;
}
