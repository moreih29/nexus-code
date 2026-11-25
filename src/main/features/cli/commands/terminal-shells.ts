import type { SettingsEditLine } from "../../../../shared/cli/consent-copy";
import type { CliChangeKind, CliShellChange, CliShellPlan } from "../../../../shared/cli/ui";
import { joinShellArgs } from "../../../../shared/pty/shell";
import { CliUsageError, exactArgs, type FlagValues } from "../args";
import type { CliContext } from "../context";
import { oneLine } from "../format";
import { type CliCommand, output } from "../registry";

const ARG_FLAG = {
  type: "string",
  value: "ARG",
  repeat: true,
  description: "An argument for the program, in order (repeatable; --arg=--login for one with --)",
} as const;

const PROGRAM_FLAG = {
  type: "string",
  value: "PATH",
  description: "The program to run: a path, or a name found on the PATH",
} as const;

function argsOf(flags: FlagValues): string[] | undefined {
  const value = flags.arg;
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [String(value)];
}

function programText(path: string, found: string | undefined): string {
  return found !== undefined && found !== path ? `${path} (${found})` : path;
}

function commandLine(shell: CliShellPlan["shell"]): string {
  return shell.args.length > 0 ? `${shell.path} ${joinShellArgs(shell.args)}` : shell.path;
}

async function changeShell(
  ctx: CliContext,
  change: CliShellChange,
  kind: CliChangeKind,
  linesOf: (plan: CliShellPlan) => SettingsEditLine[],
): Promise<CliShellPlan> {
  const plan = await ctx.services.ui("terminal.shells.change", { change });
  await ctx.services.askUser(
    {
      fromWorkspaceId: ctx.caller.workspaceId,
      fromTabId: ctx.caller.tabId,
      toWorkspaceId: ctx.caller.workspaceId,
      change: {
        kind,
        detail: plan.before?.name ?? plan.shell.name,
        settingsEdit: { lines: linesOf(plan) },
        eachTime: true,
      },
    },
    ctx.signal,
  );
  ctx.signal?.throwIfAborted();
  return ctx.services.ui("terminal.shells.change", {
    change,
    approved: true,
    before: plan.snapshot,
  });
}

function shellJson(plan: CliShellPlan) {
  return {
    shell: plan.shell,
    ...(plan.found !== undefined ? { found: plan.found } : {}),
  };
}

const APPROVAL =
  "The user approves each time, seeing the program and its arguments. Shells are for local\n" +
  "workspaces; nexus terminal new --shell NAME opens one and nexus settings set terminal.shell\n" +
  "NAME makes it the default.";

const shellsAdd: CliCommand = {
  path: ["terminal", "shells", "add"],
  summary: "Add a shell for new terminals, as Settings › Terminal does, with the user's approval",
  args: "<name>",
  details:
    "The program must be found on this computer. The name must not be another shell's,\n" +
    `nor "system".\n${APPROVAL}`,
  flags: { program: PROGRAM_FLAG, arg: ARG_FLAG },
  async run(ctx, { positionals, flags }) {
    const [name] = exactArgs(positionals, "name") as [string];
    if (typeof flags.program !== "string") throw new CliUsageError("give --program PATH");
    const change: CliShellChange = {
      op: "add",
      name,
      program: flags.program,
      args: argsOf(flags) ?? [],
    };
    const plan = await changeShell(ctx, change, "shellAdd", ({ shell, found }) => [
      { field: "program", to: programText(shell.path, found) },
      { field: "args", to: joinShellArgs(shell.args) },
    ]);
    return output(
      `Added the shell "${oneLine(plan.shell.name, 80)}": ${commandLine(plan.shell)}.`,
      shellJson(plan),
    );
  },
};

const shellsEdit: CliCommand = {
  path: ["terminal", "shells", "edit"],
  summary: "Change a shell added in Settings or with terminal shells add, with the user's approval",
  args: "<shell>",
  details:
    "Give the shell's name or id, and what changes: --name, --program, and --arg (the whole\n" +
    `list) or --clear-args. Shells found on the computer cannot be changed.\n${APPROVAL}`,
  flags: {
    name: { type: "string", value: "NAME", description: "A new name" },
    program: PROGRAM_FLAG,
    arg: ARG_FLAG,
    "clear-args": { type: "boolean", description: "Run the program without arguments" },
  },
  async run(ctx, { positionals, flags }) {
    const [shell] = exactArgs(positionals, "shell") as [string];
    const args = argsOf(flags);
    const clear = flags["clear-args"] === true;
    if (args !== undefined && clear)
      throw new CliUsageError("give --arg or --clear-args, not both");
    const name = typeof flags.name === "string" ? flags.name : undefined;
    const program = typeof flags.program === "string" ? flags.program : undefined;
    if (name === undefined && program === undefined && args === undefined && !clear) {
      throw new CliUsageError("give --name, --program, --arg or --clear-args");
    }
    const change: CliShellChange = {
      op: "edit",
      shell,
      ...(name !== undefined ? { name } : {}),
      ...(program !== undefined ? { program } : {}),
      ...(args !== undefined || clear ? { args: args ?? [] } : {}),
    };
    const plan = await changeShell(ctx, change, "shellEdit", ({ shell: after, before, found }) => {
      const lines: SettingsEditLine[] = [];
      if (!before) return lines;
      if (after.name !== before.name)
        lines.push({ field: "name", from: before.name, to: after.name });
      const path = programText(after.path, found);
      lines.push(
        after.path !== before.path
          ? { field: "program", from: before.path, to: path }
          : { field: "program", to: path },
      );
      const from = joinShellArgs(before.args);
      const to = joinShellArgs(after.args);
      lines.push(from !== to ? { field: "args", from, to } : { field: "args", to });
      return lines;
    });
    return output(
      `Changed the shell "${oneLine(plan.shell.name, 80)}": ${commandLine(plan.shell)}.`,
      shellJson(plan),
    );
  },
};

const shellsRemove: CliCommand = {
  path: ["terminal", "shells", "remove"],
  summary: "Remove a shell added in Settings or with terminal shells add, with the user's approval",
  args: "<shell>",
  details:
    "Give the shell's name or id. As in Settings, if it was the default shell, new terminals\n" +
    "run the system's default. Open terminals keep running. The user approves each time.",
  async run(ctx, { positionals }) {
    const [shell] = exactArgs(positionals, "shell") as [string];
    const plan = await changeShell(ctx, { op: "remove", shell }, "shellRemove", (p) => [
      { field: "program", to: p.shell.path },
      { field: "args", to: joinShellArgs(p.shell.args) },
      ...(p.wasDefault ? [{ field: "defaultShell", from: p.shell.name } as const] : []),
    ]);
    const fallback = plan.wasDefault ? " New terminals run the system's default shell." : "";
    return output(`Removed the shell "${oneLine(plan.shell.name, 80)}".${fallback}`, {
      ...shellJson(plan),
      removed: true,
      ...(plan.wasDefault ? { wasDefault: true } : {}),
    });
  },
};

export const terminalShellCommands: CliCommand[] = [shellsAdd, shellsEdit, shellsRemove];
