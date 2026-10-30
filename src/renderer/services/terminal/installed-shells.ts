/**
 * The shells installed on this machine, as main finds them (pty.listShells),
 * for Settings › Terminal and the tab bar's "New terminal with" menu.
 */

import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import type { ShellChoice, ShellInfo } from "../../../shared/pty/shell";
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

/** Whether a choice picks this installed shell. */
export function isChosenShell(choice: ShellChoice | undefined, shell: ShellInfo): boolean {
  return choice?.kind === "detected" && choice.id === shell.id;
}
