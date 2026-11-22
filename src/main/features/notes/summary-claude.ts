import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { connectionKeyTarget } from "../../../shared/agent-profiles/connection";
import { agentEnvValue, mergeAgentEnv } from "../../../shared/agent-profiles/env";
import type { AgentProfile } from "../../../shared/agent-profiles/profiles";
import { claudeStatusOf } from "../../../shared/agent-profiles/status";
import type { SummaryError } from "../../../shared/notes/summary";
import type { AgentChannel } from "../../infra/agent/channel";
import {
  createLocalChannel,
  waitForLocalAgentShutdowns,
} from "../../infra/agent/channel/local-channel";
import { resolveLocalAgentCommand } from "../../infra/agent/local-agent-resolver";
import { claudeConnectionEnv } from "../agent-profiles/connection-launch";
import { localProfileDir } from "../agent-profiles/local";
import { parseSummaryResult, type SummaryRunResult, summaryArgs } from "./summary-text";

const RUN_TIMEOUT_MS = 15 * 60_000;
const STATUS_TIMEOUT_MS = 20_000;
const windows = process.platform === "win32";
const hostEnvKeys = new Set([
  "HOME",
  "USERPROFILE",
  "SYSTEMROOT",
  "WINDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
]);
const profileEnvKeys = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

/** Only runtime necessities and the selected profile's connection are passed to Claude. */
function summaryEnv(
  profile: AgentProfile,
  cleanPath: string,
  key?: string,
): Record<string, string> {
  const host = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      hostEnvKeys.has(windows ? name.toUpperCase() : name),
    ),
  );
  const auth = Object.fromEntries(
    Object.entries(profile.env ?? {}).filter(([name]) =>
      profileEnvKeys.has(windows ? name.toUpperCase() : name),
    ),
  );
  return mergeAgentEnv(windows, host, auth, claudeConnectionEnv(profile.connection, key), {
    CLAUDE_CONFIG_DIR: localProfileDir(profile),
    PATH: cleanPath,
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  });
}

export type RunClaudeSummary = (input: {
  runId: string;
  profile: AgentProfile;
  model?: string;
  language: string;
  stdin: string;
  signal: AbortSignal;
}) => Promise<ReturnType<typeof parseSummaryResult>>;

function withError(kind: SummaryError["kind"], message?: string) {
  return { error: { kind, message } };
}

export function localClaudeSummary(options: {
  connectionKey?: (id: string, target: string | undefined) => Promise<string | undefined>;
  openChannel?: (rootPath: string) => AgentChannel;
}): RunClaudeSummary {
  const open =
    options.openChannel ??
    ((rootPath) => createLocalChannel({ ...resolveLocalAgentCommand(), rootPath }));
  return async ({ runId, profile, model, language, stdin, signal }) => {
    signal.throwIfAborted();
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-note-summary-"));
    let channel: AgentChannel | undefined;
    try {
      signal.throwIfAborted();
      const key = await options.connectionKey?.(
        profile.id,
        connectionKeyTarget("claude", profile.connection),
      );
      if (profile.connection?.method === "api-key" && !key) return withError("signed-out");
      signal.throwIfAborted();
      const local = open(cwd);
      channel = local;
      const searchPath = agentEnvValue(profile.env ?? {}, "PATH", windows);
      const stopLookup = () => local.dispose();
      signal.addEventListener("abort", stopLookup, { once: true });
      const found = await local
        .call<{ path: string; envPath?: string }>("lsp.findBinary", {
          name: "claude",
          dir: cwd,
          searchPath,
          excludeAgentWrappers: true,
        })
        .finally(() => signal.removeEventListener("abort", stopLookup));
      signal.throwIfAborted();
      if (!found.path) return withError("missing");
      const env = summaryEnv(profile, found.envPath ?? "", key);
      const status = await run(channel, signal, {
        runId: `${runId}:status`,
        cwd,
        program: found.path,
        env,
        args: ["--setting-sources", "", "auth", "status", "--json"],
        stdin: "",
        timeoutMs: STATUS_TIMEOUT_MS,
      });
      if (status.canceled || status.timedOut) return parseSummaryResult(status);
      const auth = claudeStatusOf(status.stdout);
      if (auth?.state === "signed-out") return withError("signed-out");
      if (!auth || status.code !== 0) {
        return withError("failed", "Claude auth status gave no answer");
      }
      const apiKey =
        profile.connection?.method === "api-key" ||
        Boolean(agentEnvValue(env, "ANTHROPIC_API_KEY", windows));
      return parseSummaryResult(
        await run(channel, signal, {
          runId,
          cwd,
          program: found.path,
          env,
          args: summaryArgs(language, model, apiKey),
          stdin,
          timeoutMs: RUN_TIMEOUT_MS,
        }),
      );
    } finally {
      if (channel) {
        channel.dispose();
        await waitForLocalAgentShutdowns();
      }
      await fs.rm(cwd, { recursive: true, force: true });
    }
  };
}

function run(
  channel: AgentChannel,
  signal: AbortSignal,
  params: {
    runId: string;
    cwd: string;
    program: string;
    env: Record<string, string>;
    args: string[];
    stdin: string;
    timeoutMs: number;
  },
): Promise<SummaryRunResult> {
  signal.throwIfAborted();
  const reply = channel.call<SummaryRunResult>("chat.run", params, {
    timeoutMs: params.timeoutMs + 5000,
  });
  const abort = () => {
    // The cancel handler can reach an idle agent before the run goroutine.
    // Closing this run's private channel also cancels its request context.
    void channel.call<boolean>("chat.cancelRun", { runId: params.runId }, { timeoutMs: 2000 }).then(
      (found) => {
        if (!found) channel.dispose();
      },
      () => channel.dispose(),
    );
  };
  signal.addEventListener("abort", abort, { once: true });
  return reply.finally(() => signal.removeEventListener("abort", abort));
}
