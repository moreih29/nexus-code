import i18next, { type TFunction } from "i18next";
import { useEffect, useState } from "react";
import type { CustomShell, ShellChoice, ShellInfo } from "../../../shared/pty/shell";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import { useTerminalStore } from "../../state/stores/terminal";

export interface InstalledShells {
  shells: ShellInfo[];
  systemDefault: ShellInfo;
}

let cached: Promise<InstalledShells> | null = null;

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

export function shellDisplayName(t: TFunction, shell: ShellInfo): string {
  return shell.id === "cmd" ? t("settings:terminal.shell.cmd") : shell.name;
}

export interface ShellEntry {
  choice: ShellChoice;
  name: string;
  path: string;
  args: readonly string[];
}

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

export async function loadShellMenu(): Promise<{
  entries: ShellEntry[];
  defaultShell: ShellChoice;
}> {
  const installed = await loadInstalledShells();
  const { customShells, shell } = useTerminalStore.getState();
  return {
    entries: shellEntries(i18next.t, installed, customShells),
    defaultShell: shell ?? { kind: "detected", id: installed.systemDefault.id },
  };
}

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

function programName(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).replace(/\.exe$/i, "").toLowerCase();
}

export function shellNamed(entries: readonly ShellEntry[], name: string): ShellEntry | undefined {
  const wanted = name.trim().toLowerCase();
  return (
    entries.find((entry) => entry.name.toLowerCase() === wanted) ??
    entries.find((entry) => entry.choice.id.toLowerCase() === wanted) ??
    entries.find((entry) => programName(entry.path) === wanted)
  );
}
