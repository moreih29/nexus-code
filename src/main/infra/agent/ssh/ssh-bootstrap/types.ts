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

// Bumped from "1" to "2": the Ready frame now carries agentEpoch +
// capabilities for daemon/dialer reattach support. The Go agent
// (internal/proto/proto.go ProtocolVersion) is bumped to "2" in the same
// commit. Legacy agents that still advertise "1" produce a clear
// server.protocol-version-mismatch; the bootstrap sha-based redeploy closes
// that window immediately.
export const REMOTE_AGENT_PROTOCOL_MAJOR = "2";
export const REMOTE_AGENT_VERSION = "0.1.0";

/**
 * 원격 호스트에서 에이전트가 설치되는 루트 경로.
 *
 * Build-time `define`으로 stable/beta 채널에 따라 분리 (`~/.nexus-code` vs
 * `~/.nexus-code-beta`). 디버깅 시 `NEXUS_REMOTE_AGENT_ROOT` env로 강제
 * 가능 (escape hatch).
 *
 * `__NEXUS_REMOTE_AGENT_ROOT__` 글로벌은 `electron.vite.config.ts`의 main
 * config `define`이 빌드 시점에 문자열로 치환한다. 테스트 환경에서는
 * `tests/setup-globals.ts`가 globalThis에 기본값을 박는다.
 */
export const REMOTE_AGENT_ROOT: string =
  process.env.NEXUS_REMOTE_AGENT_ROOT ?? __NEXUS_REMOTE_AGENT_ROOT__;

export const REMOTE_AGENT_MANIFEST: string =
  process.env.NEXUS_REMOTE_AGENT_MANIFEST ?? __NEXUS_REMOTE_AGENT_MANIFEST__;
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
