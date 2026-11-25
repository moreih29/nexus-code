import { ChevronRight, Pencil, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { CommandId } from "../../../../shared/keybindings/commands";
import {
  type ConflictBinding,
  detectTableConflicts,
  type KeybindingConflict,
} from "../../../../shared/keybindings/conflicts";
import {
  appBindingShape,
  BINDABLE_COMMANDS,
  type BindingKind,
  editorConflictBindings,
  editorEffectivePrimary,
  isSevereConflict,
  proposedBindingConflicts,
} from "../../../../shared/keybindings/edit";
import { EDITOR_COMMANDS } from "../../../../shared/keybindings/editor-commands";
import { findDisplayPrimary, type KeybindingDecl } from "../../../../shared/keybindings/index";
import {
  acceleratorToLabel,
  chordToLabel,
  eventToAccelerator,
  isModifierCode,
} from "../../../../shared/keybindings/keybinding-parse";
import {
  keybindingCommandLabel,
  keybindingConflictMessage,
} from "../../../keybindings/conflict-message";
import { labelOptions } from "../../../keybindings/shortcut-labels";
import { useKeybindingsStore } from "../../../state/stores/keybindings";
import { isLinux, isMac, isWindows } from "../../../utils/platform";
import { Checkbox } from "../../ui/checkbox";
import { SearchInput } from "../../ui/search-input";

interface Row {
  command: string;
  label: string;
  bindingLabel: string | null;
  kind: BindingKind;
  when: string | undefined;
  overridden: boolean;
  conflicts: KeybindingConflict[];
}

function bindingLabelFor(bindings: readonly KeybindingDecl[], command: CommandId): string | null {
  const primary = findDisplayPrimary(bindings, command, isMac(), isLinux());
  if (primary?.primary !== undefined) return acceleratorToLabel(primary.primary, labelOptions());
  const chord = bindings.find((b) => b.command === command && b.chord !== undefined);
  if (chord?.chord !== undefined) return chordToLabel(chord.chord, labelOptions());
  return null;
}

export function KeybindingsPanel() {
  const { t } = useTranslation("settings");
  const overrides = useKeybindingsStore((s) => s.overrides);
  const effectiveBindings = useKeybindingsStore((s) => s.effectiveBindings);
  const resetCommand = useKeybindingsStore((s) => s.resetCommand);
  const resetAll = useKeybindingsStore((s) => s.resetAll);
  const setOverride = useKeybindingsStore((s) => s.setOverride);

  const editorOverrides = useKeybindingsStore((s) => s.editorOverrides);
  const setEditorOverride = useKeybindingsStore((s) => s.setEditorOverride);
  const resetEditorCommand = useKeybindingsStore((s) => s.resetEditorCommand);

  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const [modifiedOnly, setModifiedOnly] = useState(false);
  const [conflictsOnly, setConflictsOnly] = useState(false);
  const modifiedOnlyId = useId();
  const conflictsOnlyId = useId();
  const [recordingFor, setRecordingFor] = useState<string | null>(null);
  const [confirmResetAll, setConfirmResetAll] = useState(false);

  const commandLabel = (id: string): string => keybindingCommandLabel(t, id);

  const appConflicts = useMemo(
    () => detectTableConflicts(effectiveBindings, isMac()),
    [effectiveBindings],
  );
  const editorConflictBase = useMemo(
    () => editorConflictBindings(editorOverrides),
    [editorOverrides],
  );
  const editorConflicts = useMemo(
    () => detectTableConflicts(editorConflictBase, isMac()),
    [editorConflictBase],
  );

  const conflictCount = appConflicts.size + editorConflicts.size;

  const filterActive = query.trim() !== "" || modifiedOnly || conflictsOnly;

  const matchesFilter = useCallback(
    (row: Row): boolean => {
      if (modifiedOnly && !row.overridden) return false;
      if (conflictsOnly && row.conflicts.length === 0) return false;
      const q = query.trim().toLowerCase();
      if (q === "") return true;
      return (
        row.label.toLowerCase().includes(q) ||
        row.command.toLowerCase().includes(q) ||
        (row.bindingLabel?.toLowerCase().includes(q) ?? false)
      );
    },
    [query, modifiedOnly, conflictsOnly],
  );

  const appRows = useMemo<Row[]>(() => {
    return BINDABLE_COMMANDS.map((command): Row => {
      const { kind, when } = appBindingShape(command);
      return {
        command,
        label: t(`keybindings.command.${command}`),
        bindingLabel: bindingLabelFor(effectiveBindings, command),
        kind,
        when,
        overridden: overrides.some((o) => o.command === command),
        conflicts: appConflicts.get(command) ?? [],
      };
    }).filter(matchesFilter);
  }, [t, effectiveBindings, overrides, appConflicts, matchesFilter]);

  const editorRows = useMemo<Row[]>(() => {
    return EDITOR_COMMANDS.map((c): Row => {
      const primary = editorEffectivePrimary(editorOverrides, c.id, c.defaultPrimary);
      return {
        command: c.id,
        label: t(`keybindings.editorCommand.${c.slug}`),
        bindingLabel: primary !== null ? acceleratorToLabel(primary, labelOptions()) : null,
        kind: "primary",
        when: undefined,
        overridden: editorOverrides.some((o) => o.command === c.id),
        conflicts: editorConflicts.get(c.id) ?? [],
      };
    }).filter(matchesFilter);
  }, [t, editorOverrides, editorConflicts, matchesFilter]);

  const hasOverrides = overrides.length > 0 || editorOverrides.length > 0;

  return (
    <div ref={panelRef} className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <SearchInput
          value={query}
          onChange={setQuery}
          onKeyDown={(event) => {
            const go = event.key === "ArrowDown" || (event.key === "Enter" && query !== "");
            if (!go) return;
            const first = panelRef.current?.querySelector<HTMLElement>("[data-keybinding-edit]");
            if (!first) return;
            event.preventDefault();
            first.focus();
          }}
          label={t("keybindings.searchPlaceholder")}
          className="flex-1"
        />
        <label
          htmlFor={modifiedOnlyId}
          className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-app-ui-sm text-muted-foreground"
        >
          <Checkbox
            id={modifiedOnlyId}
            checked={modifiedOnly}
            onCheckedChange={(v) => setModifiedOnly(v === true)}
          />
          {t("keybindings.modifiedOnly")}
        </label>
        <label
          htmlFor={conflictsOnlyId}
          className={cn(
            "flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-app-ui-sm",
            conflictCount > 0 ? "text-destructive" : "text-muted-foreground",
          )}
        >
          <Checkbox
            id={conflictsOnlyId}
            checked={conflictsOnly}
            onCheckedChange={(v) => setConflictsOnly(v === true)}
          />
          {conflictCount > 0
            ? t("keybindings.conflictsOnlyCount", { count: conflictCount })
            : t("keybindings.conflictsOnly")}
        </label>
        <button
          type="button"
          disabled={!hasOverrides}
          onClick={() => {
            if (!confirmResetAll) {
              setConfirmResetAll(true);
              return;
            }
            resetAll();
            useKeybindingsStore.getState().resetAllEditor();
            setConfirmResetAll(false);
          }}
          onBlur={() => setConfirmResetAll(false)}
          className={cn(
            "shrink-0 rounded-(--radius-control) border border-border px-2 py-1 text-app-ui-sm",
            hasOverrides
              ? "text-foreground hover:bg-[var(--state-hover-bg)] cursor-pointer"
              : "text-muted-foreground opacity-50",
          )}
        >
          {confirmResetAll ? t("keybindings.resetAllConfirm") : t("keybindings.resetAll")}
        </button>
      </div>

      <CommandSection
        heading={t("keybindings.section.app")}
        rows={appRows}
        conflictCount={appConflicts.size}
        filterActive={filterActive}
        conflictBindings={effectiveBindings}
        commandLabel={commandLabel}
        recordingFor={recordingFor}
        setRecordingFor={setRecordingFor}
        onCommit={(command, kind, value) =>
          setOverride(
            kind === "chord"
              ? { command, chord: value as [string, string] }
              : { command, primary: value[0] as string },
          )
        }
        onUnbind={(command, kind) =>
          setOverride(kind === "chord" ? { command, chord: null } : { command, primary: null })
        }
        onReset={resetCommand}
      />

      <CommandSection
        heading={t("keybindings.section.editor")}
        description={t("keybindings.section.editorDescription")}
        rows={editorRows}
        conflictCount={editorConflicts.size}
        filterActive={filterActive}
        conflictBindings={editorConflictBase}
        commandLabel={commandLabel}
        recordingFor={recordingFor}
        setRecordingFor={setRecordingFor}
        onCommit={(command, _kind, value) =>
          setEditorOverride({ command, primary: value[0] as string })
        }
        onUnbind={(command) => setEditorOverride({ command, primary: null })}
        onReset={resetEditorCommand}
      />
    </div>
  );
}

interface CommandSectionProps {
  heading: string;
  description?: string;
  rows: Row[];
  conflictCount: number;
  filterActive: boolean;
  conflictBindings: readonly ConflictBinding[];
  commandLabel: (id: string) => string;
  recordingFor: string | null;
  setRecordingFor: (id: string | null) => void;
  onCommit: (command: string, kind: BindingKind, value: readonly string[]) => void;
  onUnbind: (command: string, kind: BindingKind) => void;
  onReset: (command: string) => void;
}

function CommandSection({
  heading,
  description,
  rows,
  conflictCount,
  filterActive,
  conflictBindings,
  commandLabel,
  recordingFor,
  setRecordingFor,
  onCommit,
  onUnbind,
  onReset,
}: CommandSectionProps) {
  const { t } = useTranslation("settings");
  const [userOpen, setUserOpen] = useState(false);
  const forceOpen = filterActive && rows.length > 0;
  const open = forceOpen || userOpen;

  const conflictLine = (conflicts: KeybindingConflict[]): string => {
    return conflicts
      .map((c) =>
        t(`keybindings.conflict.${c.kind === "overlap" ? "overlap" : "blocking"}`, {
          command: c.command !== undefined ? commandLabel(c.command) : "?",
        }),
      )
      .join(" · ");
  };

  return (
    <details
      open={open}
      onToggle={(e) => {
        if (!forceOpen) setUserOpen(e.currentTarget.open);
      }}
      className="flex flex-col gap-1.5"
    >
      <summary
        className={cn(
          "flex cursor-pointer select-none items-center gap-1.5 rounded-(--radius-control) px-1 py-1",
          "text-app-body text-foreground hover:bg-[var(--state-hover-bg)]",
          "list-none [&::-webkit-details-marker]:hidden",
        )}
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
          aria-hidden="true"
        />
        <span>{heading}</span>
        <span className="text-app-label text-muted-foreground">{rows.length}</span>
        {conflictCount > 0 && (
          <span className="text-app-label text-destructive">
            ⚠ {t("keybindings.sectionConflicts", { count: conflictCount })}
          </span>
        )}
      </summary>
      {description !== undefined && (
        <span className="text-app-label text-muted-foreground">{description}</span>
      )}
      <div className="flex flex-col divide-y divide-border rounded-(--radius-control) border border-border">
        {rows.map((row) => (
          <div key={row.command} className="flex items-center gap-2 px-3 py-1.5">
            <div className="min-w-0 flex-1">
              <span className="block truncate text-app-body text-foreground">{row.label}</span>
              <span className="block truncate text-app-label text-muted-foreground">
                {row.command}
              </span>
              {row.conflicts.length > 0 && (
                <span className="block truncate text-app-label text-destructive">
                  ⚠ {conflictLine(row.conflicts)}
                </span>
              )}
            </div>

            {recordingFor === row.command ? (
              <KeybindingRecorder
                command={row.command}
                kind={row.kind}
                when={row.when}
                bindings={conflictBindings}
                hasBinding={row.bindingLabel !== null}
                onCommit={(value) => {
                  onCommit(row.command, row.kind, value);
                  setRecordingFor(null);
                }}
                onUnbind={() => {
                  onUnbind(row.command, row.kind);
                  setRecordingFor(null);
                }}
                onCancel={() => setRecordingFor(null)}
              />
            ) : (
              <>
                <span
                  className={cn(
                    "shrink-0 font-mono text-app-ui-sm",
                    row.conflicts.length > 0
                      ? "text-destructive"
                      : row.bindingLabel !== null
                        ? "text-foreground"
                        : "text-muted-foreground",
                  )}
                >
                  {row.bindingLabel ?? t("keybindings.unbound")}
                </span>
                <span
                  className={cn(
                    "w-14 shrink-0 text-right text-app-label",
                    row.overridden ? "text-[var(--state-selected-fg)]" : "text-muted-foreground",
                  )}
                >
                  {row.overridden ? t("keybindings.source.user") : t("keybindings.source.default")}
                </span>
                <button
                  type="button"
                  aria-label={t("keybindings.edit")}
                  title={t("keybindings.edit")}
                  data-keybinding-edit=""
                  onClick={() => setRecordingFor(row.command)}
                  className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                >
                  <Pencil className="size-3" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={t("keybindings.reset")}
                  title={t("keybindings.reset")}
                  onClick={() => onReset(row.command)}
                  className={cn(
                    "shrink-0 text-muted-foreground hover:text-foreground",
                    row.overridden ? "cursor-pointer" : "invisible",
                  )}
                >
                  <RotateCcw className="size-3" aria-hidden="true" />
                </button>
              </>
            )}
          </div>
        ))}
        {rows.length === 0 && (
          <div className="px-3 py-4 text-app-ui-sm text-muted-foreground">
            {t("keybindings.empty")}
          </div>
        )}
      </div>
    </details>
  );
}

interface KeybindingRecorderProps {
  command: string;
  kind: BindingKind;
  when: string | undefined;
  bindings: readonly ConflictBinding[];
  hasBinding: boolean;
  onCommit: (value: readonly string[]) => void;
  onUnbind: () => void;
  onCancel: () => void;
}

function KeybindingRecorder({
  command,
  kind,
  when,
  bindings,
  hasBinding,
  onCommit,
  onUnbind,
  onCancel,
}: KeybindingRecorderProps) {
  const { t } = useTranslation("settings");
  const [captured, setCaptured] = useState<string[]>([]);
  const [unsupported, setUnsupported] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const captureRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    captureRef.current?.focus();
  }, []);

  const needed = kind === "chord" ? 2 : 1;
  const complete = captured.length === needed;

  const conflicts = useMemo(() => {
    if (!complete) return [];
    return proposedBindingConflicts({
      command,
      kind,
      when,
      keys: captured,
      bindings,
      isMac: isMac(),
      isWindows: isWindows(),
    });
  }, [complete, captured, command, kind, when, bindings]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (isModifierCode(e.nativeEvent.code)) return;

    const noMods = !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
    if (e.key === "Escape" && noMods) {
      onCancel();
      return;
    }
    if (e.key === "Enter" && noMods && complete) {
      onCommit(captured);
      return;
    }

    const accel = eventToAccelerator(e.nativeEvent, isMac());
    if (accel === null) {
      setUnsupported(true);
      return;
    }
    setUnsupported(false);
    setCaptured((prev) => {
      if (kind === "primary") return [accel];
      if (prev.length === 0 || prev.length >= 2) return [accel];
      return [prev[0] as string, accel];
    });
  }

  const capturedLabel =
    captured.length > 0
      ? captured.map((a) => acceleratorToLabel(a, labelOptions())).join(" ")
      : t("keybindings.record.prompt");
  const promptSecond = kind === "chord" && captured.length === 1;

  return (
    // biome-ignore lint/a11y/useSemanticElements: <fieldset> styles poorly inline and adds form semantics this transient recorder doesn't have; role="group" + label conveys the structure.
    <div
      ref={containerRef}
      data-keybinding-recorder
      role="group"
      aria-label={t("keybindings.edit")}
      className="flex shrink-0 flex-col items-end gap-1"
      onBlur={(e) => {
        if (containerRef.current && !containerRef.current.contains(e.relatedTarget as Node)) {
          onCancel();
        }
      }}
    >
      <div className="flex items-center gap-1.5">
        {/* biome-ignore lint/a11y/useSemanticElements: a real <input> would fight the raw-keystroke capture; this div mimics VSCode's recorder box. */}
        <div
          ref={captureRef}
          role="textbox"
          aria-label={t("keybindings.record.prompt")}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          className={cn(
            "min-w-44 rounded-(--radius-control) border px-2 py-1 text-center font-mono text-app-ui-sm",
            "border-[var(--state-selected-indicator)] text-foreground outline-none",
            captured.length === 0 && "text-muted-foreground",
          )}
        >
          {promptSecond
            ? `${capturedLabel} · ${t("keybindings.record.promptSecond")}`
            : capturedLabel}
        </div>
        <button
          type="button"
          disabled={!complete}
          onClick={() => onCommit(captured)}
          className={cn(
            "rounded-(--radius-control) border border-border px-2 py-1 text-app-ui-sm",
            complete
              ? "cursor-pointer text-foreground hover:bg-[var(--state-hover-bg)]"
              : "text-muted-foreground opacity-50",
          )}
        >
          {t("keybindings.record.commit")}
        </button>
        {hasBinding && (
          <button
            type="button"
            aria-label={t("keybindings.unbind")}
            title={t("keybindings.unbind")}
            onClick={onUnbind}
            className="cursor-pointer text-muted-foreground hover:text-foreground"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        )}
      </div>

      <span className="text-app-label text-muted-foreground">
        {unsupported ? t("keybindings.record.unsupported") : t("keybindings.record.hint")}
      </span>

      {conflicts.map((c, i) => {
        const key = `${c.kind}-${c.command ?? c.reserved?.accelerator ?? i}`;
        const message = keybindingConflictMessage(t, c);
        const severe = isSevereConflict(c);
        return (
          <span
            key={key}
            className={cn(
              "max-w-72 text-right text-app-label",
              severe ? "text-destructive" : "text-muted-foreground",
            )}
          >
            ⚠ {message}
          </span>
        );
      })}
    </div>
  );
}
