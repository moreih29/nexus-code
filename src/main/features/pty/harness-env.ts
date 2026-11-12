// Terminal environment injector — ensures PTY sessions carry the identifiers
// that enable OSC 9 notification emission in Claude Code and similar tools.
// T2 extension: NEXUS_* environment variable injection.

const HARNESS_TERM_PROGRAM = "ghostty";
const HARNESS_TERM_PROGRAM_VERSION = "1.0";

/**
 * Context argument passed to injectHarnessTerminalEnv.
 *
 * - binDir: absolute path of the bin directory that holds the wrapper binaries (required).
 *   Used for NEXUS_WRAPPER_SELF_DIR.
 *   The caller decides it with WorkspaceManager.getWrapperBinDir() and passes it in.
 * - workspaceId / tabId: identifiers of the PTY spawn request. The wrapper injects them as
 *   NEXUS_WORKSPACE_ID / NEXUS_TAB_ID.
 * - agentBin: absolute path of the running agent binary (optional).
 *   Set as NEXUS_AGENT_BIN when provided.
 * - agentSocket / hookToken: hookserver connection info. Set only when provided.
 */
export interface HarnessTerminalEnvContext {
  readonly binDir: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly agentBin?: string;
  readonly agentSocket?: string;
  readonly hookToken?: string;
}

/**
 * Returns a new object with the environment variables a PTY session needs.
 *
 * Injection rules:
 * 1. TERM_PROGRAM / TERM_PROGRAM_VERSION — ghostty defaults; the caller's values win.
 * 2. PATH — not set here. The agent puts NEXUS_WRAPPER_SELF_DIR first on its
 *    own host's PATH, which for an SSH workspace is the remote's, not this
 *    process's.
 * 3. NEXUS_IN_APP=1
 * 4. NEXUS_WRAPPER_SELF_DIR=<context.binDir>
 * 5. NEXUS_AGENT_BIN — set only when context.agentBin is provided. With it,
 *    NEXUS_AGENT_PRINT_RUN=1 and NEXUS_AGENT_EXEC_RUN=1: that agent runs
 *    `print-run` and `exec-run`, which an older one, still named in a
 *    terminal an older app started, does not (claude-wrapper.sh, the codex
 *    wrapper).
 * 6. NEXUS_WORKSPACE_ID / NEXUS_TAB_ID — injected from context.
 * 7. NEXUS_AGENT_SOCKET / NEXUS_HOOK_TOKEN — set only when provided in context.
 *
 * If the caller env sets the same key directly, the caller's value wins (spread order: defaults first,
 * caller second — the existing pattern is kept).
 *
 * The input object is not modified.
 * If no context is provided, only TERM_PROGRAM / TERM_PROGRAM_VERSION are set to defaults and
 * NEXUS_* is not injected.
 */
export function injectHarnessTerminalEnv(
  env: Record<string, string> | undefined,
  context?: HarnessTerminalEnvContext,
): Record<string, string> {
  // Without a context, skip the NEXUS_* injection.
  if (context === undefined) {
    const base: Record<string, string> = {
      TERM_PROGRAM: HARNESS_TERM_PROGRAM,
      TERM_PROGRAM_VERSION: HARNESS_TERM_PROGRAM_VERSION,
    };
    if (env === undefined) return base;
    return { ...base, ...env };
  }

  // Build the NEXUS_* defaults.
  const nexusBase: Record<string, string> = {
    NEXUS_IN_APP: "1",
    NEXUS_WRAPPER_SELF_DIR: context.binDir,
    NEXUS_WORKSPACE_ID: context.workspaceId,
    NEXUS_TAB_ID: context.tabId,
  };

  if (context.agentBin !== undefined) {
    nexusBase.NEXUS_AGENT_BIN = context.agentBin;
    nexusBase.NEXUS_AGENT_PRINT_RUN = "1";
    nexusBase.NEXUS_AGENT_EXEC_RUN = "1";
  }
  if (context.agentSocket !== undefined) {
    nexusBase.NEXUS_AGENT_SOCKET = context.agentSocket;
  }
  if (context.hookToken !== undefined) {
    nexusBase.NEXUS_HOOK_TOKEN = context.hookToken;
  }

  const base: Record<string, string> = {
    TERM_PROGRAM: HARNESS_TERM_PROGRAM,
    TERM_PROGRAM_VERSION: HARNESS_TERM_PROGRAM_VERSION,
    ...nexusBase,
  };

  if (env === undefined) {
    return base;
  }

  // Spread order: defaults first, caller env second — caller keys win.
  return { ...base, ...env };
}
