// Settings › Terminal › Default shell.
//
// A Select like the font family one: "System default (…)" first, then the
// shells installed on this machine (name, with the path as a second line),
// then "Custom…", which opens a program field (with Browse…), an arguments
// field and a check that the program exists. The choice applies to terminals
// opened from now on; main reads it at every spawn.

import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { type ShellChoice, joinShellArgs, splitShellArgs } from "../../../../shared/pty/shell";
import { ipcCallResult, unwrapIpcResult } from "../../../ipc/client";
import { shellDisplayName, useInstalledShells } from "../../../services/terminal/installed-shells";
import { useTerminalStore } from "../../../state/stores/terminal";
import { Button } from "../../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { SettingsSection } from "../section";

const SYSTEM_VALUE = "__system__";
const CUSTOM_VALUE = "__custom__";
const detectedValue = (id: string) => `detected:${id}`;

const inputClass = cn(
  "w-full rounded-(--radius-control) border border-border bg-background px-2 py-1",
  "text-app-body text-foreground outline-none placeholder:text-muted-foreground",
  "focus-visible:ring-1 focus-visible:ring-ring",
);

function selectValueFor(choice: ShellChoice | undefined): string {
  if (choice === undefined) return SYSTEM_VALUE;
  return choice.kind === "detected" ? detectedValue(choice.id) : CUSTOM_VALUE;
}

export function TerminalShellSection() {
  const { t } = useTranslation("settings");
  const shell = useTerminalStore((s) => s.shell);
  const setShell = useTerminalStore((s) => s.setShell);
  // Look again each time the panel opens, so a shell installed since shows up.
  const installed = useInstalledShells(true);

  const [selected, setSelected] = useState(() => selectValueFor(shell));
  const [program, setProgram] = useState(shell?.kind === "custom" ? shell.path : "");
  const [argsText, setArgsText] = useState(
    shell?.kind === "custom" ? joinShellArgs(shell.args ?? []) : "",
  );
  // Where the custom program was found: undefined while unchecked or empty.
  const [found, setFound] = useState<string | null | undefined>(undefined);

  const isWindows = window.host?.platform === "win32";
  const programId = useId();
  const argsId = useId();

  useEffect(() => {
    if (selected !== CUSTOM_VALUE || program.trim() === "") {
      setFound(undefined);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void ipcCallResult("pty", "findShell", { program: program.trim() })
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
  }, [selected, program]);

  const saveCustom = (nextProgram: string, nextArgs: string) => {
    const path = nextProgram.trim();
    if (path === "") {
      setShell(undefined);
      return;
    }
    const args = splitShellArgs(nextArgs);
    setShell({ kind: "custom", path, ...(args.length > 0 ? { args } : {}) });
  };

  const handleSelect = (value: string) => {
    setSelected(value);
    if (value === SYSTEM_VALUE) setShell(undefined);
    else if (value === CUSTOM_VALUE) saveCustom(program, argsText);
    else setShell({ kind: "detected", id: value.slice("detected:".length) });
  };

  const browse = async () => {
    const result = unwrapIpcResult(
      await ipcCallResult("dialog", "showOpenFile", {
        title: t("terminal.shell.browseTitle"),
        ...(isWindows
          ? { filters: [{ name: t("terminal.shell.programs"), extensions: ["exe", "cmd", "bat"] }] }
          : {}),
      }),
    );
    const path = result.filePaths[0];
    if (result.canceled || path === undefined) return;
    setProgram(path);
    saveCustom(path, argsText);
  };

  const reset = () => {
    setShell(undefined);
    setSelected(SYSTEM_VALUE);
    setProgram("");
    setArgsText("");
  };

  const shells = installed?.shells ?? [];
  const chosenId = shell?.kind === "detected" ? shell.id : undefined;
  // A chosen shell that is no longer installed still shows, marked missing.
  const chosenMissing =
    installed !== null && chosenId !== undefined && !shells.some((s) => s.id === chosenId);
  const shown =
    selected === SYSTEM_VALUE
      ? installed?.systemDefault
      : shells.find((s) => detectedValue(s.id) === selected);

  return (
    <SettingsSection label={t("terminal.shell.label")} dirty={shell !== undefined} onReset={reset}>
      <Select value={selected} onValueChange={handleSelect}>
        <SelectTrigger ariaLabel={t("terminal.shell.label")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={SYSTEM_VALUE}>
            {installed
              ? t("terminal.shell.system", { name: shellDisplayName(t, installed.systemDefault) })
              : t("terminal.shell.systemPlain")}
          </SelectItem>
          {shells.map((s) => (
            <SelectItem key={s.id} value={detectedValue(s.id)} description={s.path}>
              {shellDisplayName(t, s)}
            </SelectItem>
          ))}
          {chosenMissing && chosenId !== undefined && (
            <SelectItem value={detectedValue(chosenId)} description={t("terminal.shell.notFound")}>
              {chosenId}
            </SelectItem>
          )}
          <SelectItem value={CUSTOM_VALUE}>{t("terminal.shell.custom")}</SelectItem>
        </SelectContent>
      </Select>

      {shown && <p className="truncate text-app-ui-sm text-muted-foreground">{shown.path}</p>}
      {chosenMissing && selected !== SYSTEM_VALUE && selected !== CUSTOM_VALUE && (
        <p className="text-app-ui-sm text-[var(--state-warning-fg)]">
          {t("terminal.shell.missingFallback")}
        </p>
      )}

      {selected === CUSTOM_VALUE && (
        <div className="mt-1 flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor={programId} className="text-app-ui-sm text-muted-foreground">
              {t("terminal.shell.program")}
            </label>
            <div className="flex gap-2">
              <input
                id={programId}
                type="text"
                value={program}
                spellCheck={false}
                onChange={(e) => {
                  setProgram(e.target.value);
                  saveCustom(e.target.value, argsText);
                }}
                placeholder={
                  isWindows
                    ? t("terminal.shell.programPlaceholderWindows")
                    : t("terminal.shell.programPlaceholder")
                }
                className={inputClass}
              />
              <Button variant="outline" size="sm" onClick={() => void browse()}>
                {t("terminal.shell.browse")}
              </Button>
            </div>
            {found !== undefined && (
              <span
                className={cn(
                  "truncate text-app-ui-sm",
                  found === null ? "text-[var(--state-warning-fg)]" : "text-muted-foreground",
                )}
              >
                {found === null
                  ? t("terminal.shell.programNotFound")
                  : t("terminal.shell.programFound", { path: found })}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={argsId} className="text-app-ui-sm text-muted-foreground">
              {t("terminal.shell.args")}
            </label>
            <input
              id={argsId}
              type="text"
              value={argsText}
              spellCheck={false}
              onChange={(e) => {
                setArgsText(e.target.value);
                saveCustom(program, e.target.value);
              }}
              placeholder={t("terminal.shell.argsPlaceholder")}
              className={inputClass}
            />
          </div>
        </div>
      )}

      <p className="text-app-ui-sm text-muted-foreground">{t("terminal.shell.hint")}</p>
    </SettingsSection>
  );
}
