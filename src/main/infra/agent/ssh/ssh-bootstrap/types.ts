import path from "node:path";
import { AGENT_PROTOCOL_VERSION } from "../../../../../shared/agent/envelope";
import type { AgentArtifactPlatform, SshHostOs } from "../../../../../shared/agent/manifest";
import type { AuthenticateSshControlMasterDependencies, SshAuthPromptHandler } from "../auth-pty";
import type { SshMasterOptions } from "../master";

export const REMOTE_AGENT_PROTOCOL_MAJOR = AGENT_PROTOCOL_VERSION;
export const REMOTE_AGENT_VERSION = "0.1.0";
export const REMOTE_AGENT_BOOTSTRAP_TIMEOUT_MS = 120_000;

export const REMOTE_AGENT_ROOT: string =
  process.env.NEXUS_REMOTE_AGENT_ROOT ?? __NEXUS_REMOTE_AGENT_ROOT__;

export const REMOTE_AGENT_MANIFEST: string =
  process.env.NEXUS_REMOTE_AGENT_MANIFEST ?? __NEXUS_REMOTE_AGENT_MANIFEST__;
export const LOCAL_AGENT_DIST_DIR = path.join(process.cwd(), "dist", "agent");
export const LSP_BOOTSTRAP_PROGRESS_EVENT = "lsp.bootstrap.progress";

export const KEEP_REMOTE_VERSIONS = 3;

export type RemoteAgentPlatform = AgentArtifactPlatform & { readonly os: SshHostOs };

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
  readonly signal?: AbortSignal;
  readonly cachedRemoteArch?: RemoteAgentPlatform;
  readonly authMode?: "interactive" | "key-only";
  readonly workspaceId?: string;
}

export interface EnsureRemoteAgentResult {
  readonly remoteCommand: string;
  readonly remoteHome: string;
  readonly platform: RemoteAgentPlatform;
  readonly uploaded: boolean;
  readonly controlPath?: string;
  readonly dispose?: () => void;
  readonly remoteBinDir: string;
  readonly remoteShell?: string;
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
  signal?: AbortSignal,
) => Promise<SshBootstrapRunnerResult>;

export interface SshBootstrapDependencies {
  readonly runner?: SshBootstrapRunner;
  readonly distDir?: string;
  readonly now?: () => Date;
  readonly promptHandler?: SshAuthPromptHandler;
  readonly auth?: AuthenticateSshControlMasterDependencies;
  readonly onProgress?: (event: LspBootstrapProgressEvent) => void;
}
