import i18next from "i18next";
import { ipcCallResult, unwrapIpcResult } from "@/ipc/client";
import { useTerminalStore } from "@/state/stores/terminal";
import type { CliShellChange, CliShellPlan } from "../../../shared/cli/ui";
import { type CustomShell, CustomShellSchema } from "../../../shared/pty/shell";
import { loadInstalledShells, type ShellEntry, shellEntries } from "../terminal/installed-shells";
import { type CliUiHandler, UiRequestError } from "./handler";

const SYSTEM_SHELL = "system";
const CONTROL = /\p{Cc}/u;
const NAME_MAX = 128;
const PROGRAM_MAX = 1024;
const ARG_MAX = 1024;
const ARGS_MAX = 64;

function snapshotOf(): string {
  const { customShells, shell } = useTerminalStore.getState();
  return JSON.stringify({ customShells, shell: shell ?? null });
}

async function entriesNow(): Promise<ShellEntry[]> {
  const installed = await loadInstalledShells(true);
  return shellEntries(i18next.t, installed, useTerminalStore.getState().customShells);
}

function addedShell(selector: string, entries: readonly ShellEntry[]): CustomShell {
  const { customShells } = useTerminalStore.getState();
  const exact = customShells.find((shell) => shell.id === selector);
  if (exact) return exact;
  const wanted = selector.trim().toLowerCase();
  const named = customShells.filter((shell) => shell.name.trim().toLowerCase() === wanted);
  if (named.length > 1) {
    throw new UiRequestError(`more than one shell is named "${selector}"; give its id`);
  }
  const [found] = named;
  if (found) return found;
  if (entries.some((entry) => entry.name.toLowerCase() === wanted || entry.choice.id === selector))
    throw new UiRequestError(
      `"${selector}" was found on this computer: only shells added in Settings or with nexus terminal shells add can be changed`,
    );
  throw new UiRequestError(`no shell is named "${selector}"; nexus terminal shells lists them`);
}

function checkedName(name: string, entries: readonly ShellEntry[], self?: string): string {
  const text = name.trim();
  if (text === "") throw new UiRequestError("a shell needs a name");
  if (text.length > NAME_MAX) throw new UiRequestError(`a name takes up to ${NAME_MAX} characters`);
  if (CONTROL.test(text))
    throw new UiRequestError("a name is one line, without control characters");
  if (text.toLowerCase() === SYSTEM_SHELL)
    throw new UiRequestError(`"${SYSTEM_SHELL}" names the system's default shell; choose another`);
  const taken = entries.find(
    (entry) =>
      entry.name.toLowerCase() === text.toLowerCase() &&
      !(entry.choice.kind === "custom" && entry.choice.id === self),
  );
  if (taken) throw new UiRequestError(`a shell is already named "${taken.name}"`);
  return text;
}

async function checkedProgram(program: string): Promise<{ path: string; found: string }> {
  const path = program.trim();
  if (path === "") throw new UiRequestError("a shell needs a program");
  if (path.length > PROGRAM_MAX)
    throw new UiRequestError(`a program takes up to ${PROGRAM_MAX} characters`);
  if (CONTROL.test(path))
    throw new UiRequestError("a program is one line, without control characters");
  const { path: found } = unwrapIpcResult(
    await ipcCallResult("pty", "findShell", { program: path }),
  );
  if (!found) throw new UiRequestError(`no program "${path}" was found on this computer`);
  return { path, found };
}

function checkedArgs(args: readonly string[]): string[] {
  if (args.length > ARGS_MAX) throw new UiRequestError(`a shell takes up to ${ARGS_MAX} arguments`);
  for (const arg of args) {
    if (arg.length > ARG_MAX)
      throw new UiRequestError(`an argument takes up to ${ARG_MAX} characters`);
    if (CONTROL.test(arg))
      throw new UiRequestError("an argument is one line, without control characters");
  }
  return [...args];
}

function sameShell(a: CustomShell, b: CustomShell): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function planned(change: CliShellChange): Promise<Omit<CliShellPlan, "snapshot" | "saved">> {
  const entries = await entriesNow();
  const { shell: chosen } = useTerminalStore.getState();
  if (change.op === "add") {
    const name = checkedName(change.name, entries);
    const { path, found } = await checkedProgram(change.program);
    const shell = { id: crypto.randomUUID(), name, path, args: checkedArgs(change.args) };
    return { shell: CustomShellSchema.parse(shell), found, wasDefault: false };
  }
  const before = addedShell(change.shell, entries);
  const wasDefault = chosen?.kind === "custom" && chosen.id === before.id;
  if (change.op === "remove") return { shell: before, wasDefault };
  const name =
    change.name === undefined ? before.name : checkedName(change.name, entries, before.id);
  const program = change.program === undefined ? undefined : await checkedProgram(change.program);
  const shell: CustomShell = {
    id: before.id,
    name,
    path: program?.path ?? before.path,
    args: change.args === undefined ? before.args : checkedArgs(change.args),
  };
  if (sameShell(shell, before)) throw new UiRequestError("nothing would change");
  return {
    shell: CustomShellSchema.parse(shell),
    before,
    ...(program ? { found: program.found } : {}),
    wasDefault,
  };
}

export const shellHandlers: {
  "terminal.shells.change": CliUiHandler<"terminal.shells.change">;
} = {
  "terminal.shells.change": async ({ change, approved, before }) => {
    const snapshot = snapshotOf();
    const plan = await planned(change);
    if (approved !== true) return { ...plan, snapshot, saved: false };
    if (before !== snapshot || snapshotOf() !== snapshot) {
      throw new UiRequestError(
        "the shells changed while waiting for the user's approval; run the command again",
      );
    }
    const store = useTerminalStore.getState();
    if (change.op === "remove") store.removeCustomShell(plan.shell.id);
    else store.saveCustomShell(plan.shell);
    return { ...plan, snapshot: snapshotOf(), saved: true };
  },
};
