const HARNESS_TERM_PROGRAM = "ghostty";
const HARNESS_TERM_PROGRAM_VERSION = "1.0";

export interface HarnessTerminalEnvContext {
  readonly binDir: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly agentBin?: string;
  readonly agentSocket?: string;
  readonly hookToken?: string;
}

export function injectHarnessTerminalEnv(
  env: Record<string, string> | undefined,
  context?: HarnessTerminalEnvContext,
): Record<string, string> {
  if (context === undefined) {
    const base: Record<string, string> = {
      TERM_PROGRAM: HARNESS_TERM_PROGRAM,
      TERM_PROGRAM_VERSION: HARNESS_TERM_PROGRAM_VERSION,
    };
    if (env === undefined) return base;
    return { ...base, ...env };
  }

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
  };
  return { ...base, ...env, ...nexusBase };
}
