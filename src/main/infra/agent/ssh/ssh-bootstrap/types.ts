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
import type { AgentArtifactPlatform } from "../../../../../shared/agent-manifest";

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
}

export interface EnsureRemoteAgentResult {
  readonly remoteCommand: string;
  readonly platform: RemoteAgentPlatform;
  readonly uploaded: boolean;
  readonly controlPath?: string;
  readonly dispose?: () => void;
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
