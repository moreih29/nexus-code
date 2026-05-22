/**
 * Public types and constants shared by the bootstrap orchestrator and its
 * transport/manifest submodules. Keeping them in one place lets each
 * submodule import without circularity.
 */
import path from "node:path";
import type {
  AuthenticateSshControlMasterDependencies,
  SshAuthPromptHandler,
} from "../auth-pty";
import type { SshMasterOptions } from "../master";
import type { AgentArtifactPlatform } from "../../../../../shared/agent/manifest";

export const REMOTE_AGENT_PROTOCOL_MAJOR = "1";
export const REMOTE_AGENT_VERSION = "0.1.0";
export const REMOTE_AGENT_ROOT = "~/.nexus-code";
export const REMOTE_AGENT_MANIFEST = `${REMOTE_AGENT_ROOT}/manifest.json`;
export const LOCAL_AGENT_DIST_DIR = path.join(process.cwd(), "dist", "agent");
export const LSP_BOOTSTRAP_PROGRESS_EVENT = "lsp.bootstrap.progress";

export const KEEP_REMOTE_VERSIONS = 3;

export type RemoteAgentPlatform = AgentArtifactPlatform;

export type LspBootstrapProgressPhase =
  | "checking"
  | "skipped"
  | "uploading"
  | "verifying"
  | "extracting"
  | "linking"
  | "pruning"
  | "ready";

export interface LspBootstrapProgressEvent {
  readonly name: string;
  readonly phase: LspBootstrapProgressPhase;
  readonly bytesDone?: number;
  readonly bytesTotal?: number;
}

export interface EnsureRemoteAgentOptions extends Omit<SshMasterOptions, "remoteCommand"> {
  readonly remotePath: string;
  readonly cachedRemoteArch?: RemoteAgentPlatform;
  readonly authMode?: "interactive" | "key-only";
  /**
   * Workspace identifier. When provided, the bootstrap additionally uploads
   * the per-workspace PTY shim rc files (`.zshrc` / `.zshenv` / `bashrc`)
   * into `${remoteHome}/.nexus-code/shim/<workspaceId>/` and surfaces that
   * absolute path back as `remoteShimDir`. Omit on the LSP path or other
   * callers that do not spawn an interactive shell — the bootstrap stays
   * backwards-compatible and simply does not write any shim files.
   */
  readonly workspaceId?: string;
}

export interface EnsureRemoteAgentResult {
  readonly remoteCommand: string;
  readonly remoteHome: string;
  readonly platform: RemoteAgentPlatform;
  readonly uploaded: boolean;
  readonly controlPath?: string;
  readonly dispose?: () => void;
  /** Absolute path of the remote bin directory, e.g. `/home/user/.nexus-code/bin`. */
  readonly remoteBinDir: string;
  /**
   * Absolute path of the remote user's login shell (the value of `$SHELL` on
   * the remote), e.g. `/bin/zsh`. `undefined` when the remote did not expose
   * `$SHELL` or detection failed — callers should treat that as "shell shim
   * not applicable" and fall back gracefully (skip ZDOTDIR / --rcfile
   * injection rather than guessing).
   */
  readonly remoteShell?: string;
  /**
   * Absolute path of the workspace-specific shim directory **on the remote
   * host**, e.g. `/home/user/.nexus-code/shim/<workspaceId>`. Populated only
   * when `EnsureRemoteAgentOptions.workspaceId` is provided. The path is the
   * remote analogue of `runtimeDirs.shimDir(workspaceId)` and contains the
   * uploaded `.zshrc` / `.zshenv` / `bashrc` shim files that the remote zsh
   * / bash should source via `ZDOTDIR` or `--rcfile`. `undefined` when the
   * caller opted out of shim deployment (e.g. LSP-only bootstrap).
   */
  readonly remoteShimDir?: string;
}

export interface EnsureRemoteLspServerOptions extends EnsureRemoteAgentOptions {
  readonly binaryName: string;
  readonly languageId?: string;
}

export interface EnsureRemoteLspServerResult {
  readonly binaryPath: string;
  readonly args: readonly string[];
  readonly platform: RemoteAgentPlatform;
  readonly uploaded: boolean;
  readonly controlPath?: string;
  readonly dispose?: () => void;
}

export interface SshBootstrapRunnerResult {
  readonly stdout: string;
  readonly stderr?: string;
}

export type SshBootstrapRunner = (
  command: string,
  args: string[],
  input?: Buffer | string,
) => Promise<SshBootstrapRunnerResult>;

export interface SshBootstrapDependencies {
  readonly runner?: SshBootstrapRunner;
  readonly distDir?: string;
  readonly now?: () => Date;
  readonly promptHandler?: SshAuthPromptHandler;
  readonly auth?: AuthenticateSshControlMasterDependencies;
  readonly onProgress?: (event: LspBootstrapProgressEvent) => void;
}
