/**
 * The shells installed on this machine, as main finds them (pty.listShells),
 * for Settings › Terminal and the tab bar's "New terminal with" menu.
 */

import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import type { CustomShell, ShellChoice, ShellInfo } from "../../../shared/pty/shell";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";

export interface InstalledShells {
  shells: ShellInfo[];
  /** What a terminal runs when no shell is chosen. */
  systemDefault: ShellInfo;
}

let cached: Promise<InstalledShells> | null = null;

/**
 * Loads the list once per window; `refresh` looks again (the settings panel
 * does, so a shell installed since shows up without a restart).
 */
export function loadInstalledShells(refresh = false): Promise<InstalledShells> {
  if (cached === null || refresh) {
    const request = ipcCallResult("pty", "listShells", undefined).then(unwrapIpcResult);
    cached = request;
    request.catch(() => {
      if (cached === request) cached = null;
    });
  }
  return cached;
}

/** The installed shells, or null until they have loaded. */
export function useInstalledShells(refresh = false): InstalledShells | null {
  const [value, setValue] = useState<InstalledShells | null>(null);
  useEffect(() => {
    let live = true;
    loadInstalledShells(refresh)
      .then((shells) => {
        if (live) setValue(shells);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [refresh]);
  return value;
}

/** A shell's display name; "Command Prompt" is translated. */
export function shellDisplayName(t: TFunction, shell: ShellInfo): string {
  return shell.id === "cmd" ? t("settings:terminal.shell.cmd") : shell.name;
}

/** A shell to pick: one found on this machine, or one the user added. */
export interface ShellEntry {
  choice: ShellChoice;
  name: string;
  path: string;
  args: readonly string[];
}

/** The detected shells, then the added ones, as one list to pick from. */
export function shellEntries(
  t: TFunction,
  installed: InstalledShells | null,
  customShells: readonly CustomShell[],
): ShellEntry[] {
  return [
    ...(installed?.shells ?? []).map((s) => ({
      choice: { kind: "detected" as const, id: s.id },
      name: shellDisplayName(t, s),
      path: s.path,
      args: s.args,
    })),
    ...customShells.map((s) => ({
      choice: { kind: "custom" as const, id: s.id },
      name: s.name,
      path: s.path,
      args: s.args,
    })),
  ];
}

/**
 * Where main finds a program (pty.findShell), checked a moment after the
 * last change: undefined while empty or not yet checked, null if not found.
 */
export function useFoundProgram(program: string): string | null | undefined {
  const [found, setFound] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const trimmed = program.trim();
    setFound(undefined);
    if (trimmed === "") return;
    let live = true;
    const timer = setTimeout(() => {
      void ipcCallResult("pty", "findShell", { program: trimmed })
        .then(unwrapIpcResult)
        .then(({ path }) => {
          if (live) setFound(path);
        })
        .catch(() => {});
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [program]);
  return found;
}
