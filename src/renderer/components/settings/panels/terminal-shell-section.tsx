// Settings › Terminal › Default shell.
//
// A Select like the font family one: "System default (…)" first, then the
// shells found on this machine and the ones the user added, each with its
// path as a second line. "Manage shells…" opens a dialog that lists them and
// adds, edits and removes the added ones (name, program with Browse… and a
// check that it exists, arguments), so the panel stays the same height however
// many there are. Added shells show in the tab bar's "New Terminal With ›"
// too. Changes apply to terminals opened from now on; main reads them at
// every spawn.

import { Pencil, Plus, Trash2 } from "lucide-react";
import { Dialog as RadixDialog } from "radix-ui";
import { type FormEvent, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import {
  type CustomShell,
  type ShellChoice,
  joinShellArgs,
  sameShellChoice,
  splitShellArgs,
} from "../../../../shared/pty/shell";
import { ipcCallResult, unwrapIpcResult } from "../../../ipc/client";
import {
  type InstalledShells,
  type ShellEntry,
  shellDisplayName,
  shellEntries,
  useFoundProgram,
  useInstalledShells,
} from "../../../services/terminal/installed-shells";
import { useTerminalStore } from "../../../state/stores/terminal";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { SettingsSection } from "../section";

const SYSTEM_VALUE = "__system__";
const choiceValue = (choice: ShellChoice) => `${choice.kind}:${choice.id}`;

const inputClass = cn(
  "w-full rounded-(--radius-control) border border-border bg-background px-2 py-1",
  "text-app-body text-foreground outline-none placeholder:text-muted-foreground",
  "focus-visible:ring-1 focus-visible:ring-ring",
);

const iconButtonClass = cn(
  "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center",
  "rounded-(--radius-control) text-muted-foreground transition-colors",
  "hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
);

/** A shell's command line as shown: its path, then its arguments. */
function commandLine(path: string, args: readonly string[]): string {
  return args.length > 0 ? `${path} ${joinShellArgs(args)}` : path;
}

/** The name an added shell gets when its name is left empty: the program's file name. */
function programName(program: string): string {
  const base = program.trim().split(/[\\/]/).pop() ?? "";
  return base.replace(/\.(exe|cmd|bat|com)$/i, "");
}

export function TerminalShellSection() {
  // Look again each time the panel opens, so a shell installed since shows up.
  const installed = useInstalledShells(true);
  const { t } = useTranslation("settings");
  const customShells = useTerminalStore((s) => s.customShells);
  const entries = shellEntries(t, installed, customShells);
  const [managing, setManaging] = useState(false);

  return (
    <>
      <DefaultShellSection
        installed={installed}
        entries={entries}
        onManage={() => setManaging(true)}
      />
      <ManageShellsDialog open={managing} onOpenChange={setManaging} entries={entries} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Default shell
// ---------------------------------------------------------------------------

function DefaultShellSection({
  installed,
  entries,
  onManage,
}: {
  installed: InstalledShells | null;
  entries: ShellEntry[];
  onManage: () => void;
}) {
  const { t } = useTranslation("settings");
  const shell = useTerminalStore((s) => s.shell);
  const setShell = useTerminalStore((s) => s.setShell);
  const customShells = useTerminalStore((s) => s.customShells);

  const chosen = entries.find((e) => sameShellChoice(e.choice, shell));
  // A chosen shell that is no longer installed (or no longer in the list)
  // still shows, marked missing.
  const chosenMissing = installed !== null && shell !== undefined && chosen === undefined;
  const chosenCustom =
    shell?.kind === "custom" ? customShells.find((s) => s.id === shell.id) : undefined;
  const customFound = useFoundProgram(chosenCustom?.path ?? "");

  const handleSelect = (value: string) => {
    if (value === SYSTEM_VALUE) {
      setShell(undefined);
      return;
    }
    const entry = entries.find((e) => choiceValue(e.choice) === value);
    if (entry) setShell(entry.choice);
  };

  const shown =
    shell === undefined
      ? installed && commandLine(installed.systemDefault.path, installed.systemDefault.args)
      : chosen && commandLine(chosen.path, chosen.args);

  return (
    <SettingsSection
      label={t("terminal.shell.label")}
      dirty={shell !== undefined}
      onReset={() => setShell(undefined)}
    >
      <div className="flex gap-2">
        <div className="min-w-0 flex-1">
          <Select value={shell ? choiceValue(shell) : SYSTEM_VALUE} onValueChange={handleSelect}>
            <SelectTrigger ariaLabel={t("terminal.shell.label")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SYSTEM_VALUE}>
                {installed
                  ? t("terminal.shell.system", {
                      name: shellDisplayName(t, installed.systemDefault),
                    })
                  : t("terminal.shell.systemPlain")}
              </SelectItem>
              {entries.map((e) => (
                <SelectItem
                  key={choiceValue(e.choice)}
                  value={choiceValue(e.choice)}
                  description={commandLine(e.path, e.args)}
                >
                  {e.name}
                </SelectItem>
              ))}
              {chosenMissing && shell !== undefined && (
                <SelectItem value={choiceValue(shell)} description={t("terminal.shell.notFound")}>
                  {shell.kind === "detected" ? shell.id : t("terminal.shell.removed")}
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" size="sm" className="h-auto self-stretch" onClick={onManage}>
          {t("terminal.shell.manage")}
        </Button>
      </div>

      {shown && <p className="truncate text-app-ui-sm text-muted-foreground">{shown}</p>}
      {(chosenMissing || customFound === null) && (
        <p className="text-app-ui-sm text-[var(--state-warning-fg)]">
          {t("terminal.shell.missingFallback")}
        </p>
      )}
      <p className="text-app-ui-sm text-muted-foreground">{t("terminal.shell.hint")}</p>
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------
// Manage shells: the detected ones, then the added ones
// ---------------------------------------------------------------------------

function ManageShellsDialog({
  open,
  onOpenChange,
  entries,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: ShellEntry[];
}) {
  const { t } = useTranslation(["settings", "common"]);
  const customShells = useTerminalStore((s) => s.customShells);
  const saveCustomShell = useTerminalStore((s) => s.saveCustomShell);
  const removeCustomShell = useTerminalStore((s) => s.removeCustomShell);
  // The form in place of the list: the added shell being edited, "new"
  // while adding one, or null for the list.
  const [editing, setEditing] = useState<string | null>(null);
  const titleId = useId();
  const editingShell = customShells.find((s) => s.id === editing);

  const handleOpenChange = (next: boolean) => {
    if (!next) setEditing(null);
    onOpenChange(next);
  };

  const save = (shell: CustomShell) => {
    saveCustomShell(shell);
    setEditing(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      size="lg"
      aria-labelledby={titleId}
      aria-describedby={undefined}
    >
      <RadixDialog.Title id={titleId} className="text-app-body-emphasis text-foreground">
        {editing === null
          ? t("terminal.shell.manageTitle")
          : editingShell
            ? t("terminal.shell.edit", { name: editingShell.name })
            : t("terminal.shell.add")}
      </RadixDialog.Title>

      {editing !== null ? (
        <div className="mt-3">
          <CustomShellForm
            key={editing}
            initial={editingShell}
            onSave={save}
            onCancel={() => setEditing(null)}
          />
        </div>
      ) : (
        <>
          <p className="mt-1 text-app-ui-sm text-muted-foreground">
            {t("terminal.shell.listHint")}
          </p>
          <div className="mt-3 flex max-h-80 flex-col gap-0.5 overflow-y-auto">
            {entries.map((entry) => {
              const custom =
                entry.choice.kind === "custom"
                  ? customShells.find((s) => s.id === entry.choice.id)
                  : undefined;
              return (
                <ShellRow
                  key={choiceValue(entry.choice)}
                  entry={entry}
                  onEdit={custom ? () => setEditing(custom.id) : undefined}
                  onRemove={custom ? () => removeCustomShell(custom.id) : undefined}
                />
              );
            })}
          </div>
          <div className="mt-4 flex justify-between gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
              <Plus aria-hidden="true" />
              {t("terminal.shell.add")}
            </Button>
            <Button size="sm" onClick={() => handleOpenChange(false)}>
              {t("common:action.close")}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

function ShellRow({
  entry,
  onEdit,
  onRemove,
}: {
  entry: ShellEntry;
  /** Set for an added shell; a detected one can't be edited. */
  onEdit?: () => void;
  onRemove?: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const isCustom = entry.choice.kind === "custom";
  // Only an added shell can point at a program that isn't there.
  const found = useFoundProgram(isCustom ? entry.path : "");

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-(--radius-control) px-2 py-1.5",
        "hover:bg-[var(--state-hover-bg)]",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-app-body text-foreground">{entry.name}</span>
        <span className="truncate text-app-ui-sm text-muted-foreground">
          {commandLine(entry.path, entry.args)}
        </span>
        {found === null && (
          <span className="text-app-ui-sm text-[var(--state-warning-fg)]">
            {t("terminal.shell.notFound")}
          </span>
        )}
      </div>
      {onEdit && onRemove ? (
        <>
          <button
            type="button"
            aria-label={t("terminal.shell.edit", { name: entry.name })}
            title={t("common:action.edit")}
            onClick={onEdit}
            className={iconButtonClass}
          >
            <Pencil className="size-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={t("terminal.shell.remove", { name: entry.name })}
            title={t("common:action.delete")}
            onClick={onRemove}
            className={iconButtonClass}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </button>
        </>
      ) : (
        <span className="shrink-0 text-app-ui-sm text-muted-foreground">
          {t("terminal.shell.detected")}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add / edit form
// ---------------------------------------------------------------------------

function CustomShellForm({
  initial,
  onSave,
  onCancel,
}: {
  /** The shell being edited; absent when adding one. */
  initial?: CustomShell;
  onSave: (shell: CustomShell) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [name, setName] = useState(initial?.name ?? "");
  const [program, setProgram] = useState(initial?.path ?? "");
  const [argsText, setArgsText] = useState(initial ? joinShellArgs(initial.args) : "");
  const found = useFoundProgram(program);

  const isWindows = window.host?.platform === "win32";
  const nameId = useId();
  const programId = useId();
  const argsId = useId();
  const derivedName = programName(program);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const path = program.trim();
    if (path === "") return;
    onSave({
      id: initial?.id ?? crypto.randomUUID(),
      name: name.trim() || derivedName || path,
      path,
      args: splitShellArgs(argsText),
    });
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
  };

  return (
    <form
      onSubmit={submit}
      aria-label={
        initial ? t("terminal.shell.edit", { name: initial.name }) : t("terminal.shell.add")
      }
      className="flex flex-col gap-2"
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={nameId} className="text-app-ui-sm text-muted-foreground">
          {t("terminal.shell.name")}
        </label>
        <input
          id={nameId}
          type="text"
          value={name}
          maxLength={128}
          spellCheck={false}
          // biome-ignore lint/a11y/noAutofocus: the form opens on the user's own click on Add shell or Edit
          autoFocus
          onChange={(e) => setName(e.target.value)}
          placeholder={derivedName || t("terminal.shell.namePlaceholder")}
          className={inputClass}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={programId} className="text-app-ui-sm text-muted-foreground">
          {t("terminal.shell.program")}
        </label>
        <div className="flex gap-2">
          <input
            id={programId}
            type="text"
            value={program}
            maxLength={1024}
            spellCheck={false}
            onChange={(e) => setProgram(e.target.value)}
            placeholder={
              isWindows
                ? t("terminal.shell.programPlaceholderWindows")
                : t("terminal.shell.programPlaceholder")
            }
            className={inputClass}
          />
          <Button type="button" variant="outline" size="sm" onClick={() => void browse()}>
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
          onChange={(e) => setArgsText(e.target.value)}
          placeholder={t("terminal.shell.argsPlaceholder")}
          className={inputClass}
        />
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("common:action.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={program.trim() === ""}>
          {initial ? t("common:action.save") : t("terminal.shell.addSubmit")}
        </Button>
      </div>
    </form>
  );
}
