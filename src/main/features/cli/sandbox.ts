import { type CliChange, type CliTabInfo, isTerminalChange } from "../../../shared/cli/ui";
import { posixShellString } from "../../../shared/pty/shell";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import type { ChangeRequest } from "./consent";
import type { CliContext } from "./context";
import { senderOf } from "./sender";

const SANDBOX_LEVEL = { readOnly: 0, auto: 1, fullAccess: 2 } as const;
const SHELL_SPECIAL = /[\s|&;<>()$`\\'"*?[\]{}~#!^]/u;

type SandboxLevel = (typeof SANDBOX_LEVEL)[keyof typeof SANDBOX_LEVEL];
type TabRef = { workspaceId: string; tabId: string };

function codexSandboxLevel(mode?: string): SandboxLevel | undefined {
  if (mode === undefined || !Object.hasOwn(SANDBOX_LEVEL, mode)) return undefined;
  return SANDBOX_LEVEL[mode as keyof typeof SANDBOX_LEVEL];
}

export function sandboxLevel(agent: ChatAgent, mode?: string): SandboxLevel {
  return (agent === "codex" ? codexSandboxLevel(mode) : undefined) ?? SANDBOX_LEVEL.fullAccess;
}

async function chatSandbox(ctx: CliContext, ref: TabRef) {
  return ctx.services.ui("chat.sandbox", ref).catch(() => null);
}

export async function callerSandboxLevel(ctx: CliContext): Promise<SandboxLevel> {
  const caller = await senderOf(ctx);
  if (!caller || caller.kind === "app") return SANDBOX_LEVEL.fullAccess;
  if (caller.agent === "codex") {
    if (caller.kind === "tab" && !caller.device && caller.workspaceId && caller.tabId) {
      const sandbox = await chatSandbox(ctx, {
        workspaceId: caller.workspaceId,
        tabId: caller.tabId,
      });
      if (sandbox?.agent === "codex") {
        const current = codexSandboxLevel(sandbox.current) ?? SANDBOX_LEVEL.readOnly;
        const next = codexSandboxLevel(sandbox.next) ?? current;
        return current < next ? current : next;
      }
    }
    return SANDBOX_LEVEL.readOnly;
  }
  if (
    caller.agent === "claude" &&
    caller.kind === "tab" &&
    !caller.device &&
    caller.workspaceId &&
    caller.tabId
  ) {
    const sandbox = await chatSandbox(ctx, {
      workspaceId: caller.workspaceId,
      tabId: caller.tabId,
    });
    if (sandbox?.agent === "claude" && sandbox.enabled) return SANDBOX_LEVEL.readOnly;
  }
  return caller.agent === undefined || caller.device
    ? SANDBOX_LEVEL.readOnly
    : SANDBOX_LEVEL.fullAccess;
}

export async function mayExecute(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  change: CliChange,
  options: {
    target?: CliTabInfo;
    level?: SandboxLevel;
    alwaysAsk?: boolean;
    skipWorkspacePolicy?: boolean;
  } = {},
): Promise<void> {
  ctx.signal?.throwIfAborted();
  const caller = await callerSandboxLevel(ctx);
  let target = options.level ?? SANDBOX_LEVEL.fullAccess;
  if (caller < target && options.target?.type === "codex") {
    const sandbox = await chatSandbox(ctx, { workspaceId: workspace.id, tabId: options.target.id });
    if (sandbox?.agent === "codex") {
      const next = sandboxLevel("codex", sandbox.next);
      const active = sandbox.running ? sandboxLevel("codex", sandbox.current) : next;
      target = next > active ? next : active;
    }
  }
  ctx.signal?.throwIfAborted();
  const guarded = caller < target;
  const eachTime = change.eachTime || options.alwaysAsk;
  const request: ChangeRequest = {
    fromWorkspaceId: ctx.caller.workspaceId,
    fromTabId: ctx.caller.tabId,
    toWorkspaceId: workspace.id,
    change: eachTime ? { ...change, eachTime: true } : change,
  };
  let approval = request;
  if (guarded) {
    const command = ctx.invocation.argv
      .map((arg) => (arg === "" || SHELL_SPECIAL.test(arg) ? posixShellString(arg) : arg))
      .join(" ");
    approval = {
      ...request,
      change: {
        kind: "sandboxExecution",
        ...(change.detail === undefined ? {} : { detail: change.detail }),
        body: [`nexus ${command}`, change.body].filter(Boolean).join("\n\n"),
        ...(eachTime ? { eachTime: true } : {}),
        ...(isTerminalChange(change) ? { terminal: true } : {}),
      },
      sandbox: { verified: ctx.caller.verified === true, workspaceChange: change },
    };
  }
  const sameWorkspace = workspace.id === ctx.caller.workspaceId;
  if (options.alwaysAsk || (guarded && (sameWorkspace || options.skipWorkspacePolicy))) {
    const other = options.alwaysAsk && !sameWorkspace && !options.skipWorkspacePolicy;
    await ctx.services.askUser(
      other ? { ...approval, otherWorkspaces: true } : approval,
      ctx.signal,
    );
  } else if (!sameWorkspace && !options.skipWorkspacePolicy) {
    await ctx.services.allowChange(approval, ctx.signal);
  }
  ctx.signal?.throwIfAborted();
}
