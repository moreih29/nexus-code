// src/renderer/components/settings/panels/keybindings-panel.tsx
//
// Keyboard Shortcuts panel — VSCode-style command table with inline
// recording. Two sections:
//
//   - "Application" — commands the global dispatcher owns (KEYBINDINGS
//     table). Rebinding recompiles the dispatcher and rebuilds the
//     native menu's accelerator labels.
//   - "Editor" — a curated set of Monaco editor commands (see
//     shared/keybindings/editor-commands.ts). Rebinding reconciles
//     Monaco's own keybinding service; these fire only while the editor
//     has focus.
//
// Conflict model (VSCode-aligned): saving is NEVER blocked. A conflict
// is a property of the effective TABLE, not of the recording moment, so
// every row that collides with another command carries a persistent
// badge — including conflicts created indirectly (resetting a command
// onto a now-taken default, or the *other* side being rebound onto your
// key). The "Conflicts only" filter and the header count surface them at
// a glance. The live recorder additionally previews record-time warnings
// (including shadow/system collisions with built-in keys) but only warns
// — it does not refuse the save.
//
// `when` scopes are NOT editable — a recorded binding inherits the
// command's default scope (see overrides.ts for the rationale).
//
// Recording grammar: commands whose DEFAULT binding is a chord record
// two strokes; everything else records one. Esc cancels (bare Escape is
// therefore not bindable — it is the universal dismiss key); Enter with
// a complete capture saves (bare Enter is recordable only as the FIRST
// stroke, which is fine — the only bare-Enter default is scope-gated).

import { ChevronRight, Pencil, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { ALL_COMMAND_IDS, COMMANDS, type CommandId } from "../../../../shared/keybindings/commands";
import {
  type ConflictBinding,
  detectConflicts,
  detectTableConflicts,
  type KeybindingConflict,
} from "../../../../shared/keybindings/conflicts";
import { EDITOR_COMMANDS } from "../../../../shared/keybindings/editor-commands";
import { KEYBINDINGS, type KeybindingDecl } from "../../../../shared/keybindings/index";
import {
  acceleratorToLabel,
  chordToLabel,
  eventToAccelerator,
  isModifierCode,
} from "../../../../shared/keybindings/keybinding-parse";
import type { KeybindingOverride } from "../../../../shared/keybindings/overrides";
import { isMac } from "../../../keybindings/shortcut-labels";
import { useKeybindingsStore } from "../../../state/stores/keybindings";

// `updates.check` is dispatched inside the main process from the menu —
// the renderer registry has no handler for it, so a keybinding would be
// a silent no-op. Excluded from the panel.
type BindableCommandId = Exclude<CommandId, typeof COMMANDS.updatesCheck>;
const BINDABLE_COMMANDS = ALL_COMMAND_IDS.filter(
  (id): id is BindableCommandId => id !== COMMANDS.updatesCheck,
);

type BindingKind = "primary" | "chord";

interface Row {
  command: string;
  label: string;
  /** Rendered label of the effective binding, or null when unbound. */
  bindingLabel: string | null;
  kind: BindingKind;
  when: string | undefined;
  overridden: boolean;
  /** Command-vs-command collisions affecting this row (persistent). */
  conflicts: KeybindingConflict[];
}

function defaultDeclFor(command: CommandId): KeybindingDecl | undefined {
  return KEYBINDINGS.find((b) => b.command === command);
}

function bindingLabelFor(bindings: readonly KeybindingDecl[], command: CommandId): string | null {
  const primary = bindings.find((b) => b.command === command && b.primary !== undefined);
  if (primary?.primary !== undefined) return acceleratorToLabel(primary.primary, { isMac });
  const chord = bindings.find((b) => b.command === command && b.chord !== undefined);
  if (chord?.chord !== undefined) return chordToLabel(chord.chord, { isMac });
  return null;
}

// ---------------------------------------------------------------------------
// Editor-command helpers (Monaco namespace)
// ---------------------------------------------------------------------------

/** Effective primary keystroke for one editor command (override → default). */
function editorEffectivePrimary(
  overrides: readonly KeybindingOverride[],
  id: string,
  fallback: string | undefined,
): string | null {
  const ov = overrides.find((o) => o.command === id);
  if (ov === undefined || ov.primary === undefined) return fallback ?? null;
  return ov.primary; // string = replace, null = unbind
}

/** Synthetic binding list the conflict engine compares editor captures against. */
function editorConflictBindings(overrides: readonly KeybindingOverride[]): ConflictBinding[] {
  const out: ConflictBinding[] = [];
  for (const c of EDITOR_COMMANDS) {
    const primary = editorEffectivePrimary(overrides, c.id, c.defaultPrimary);
    if (primary !== null) out.push({ command: c.id, primary });
  }
  return out;
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
  const [modifiedOnly, setModifiedOnly] = useState(false);
  const [conflictsOnly, setConflictsOnly] = useState(false);
  // One recorder at a time across BOTH sections — keyed by command id.
  const [recordingFor, setRecordingFor] = useState<string | null>(null);
  const [confirmResetAll, setConfirmResetAll] = useState(false);

  const appCommandLabel = (id: string): string => t(`keybindings.command.${id}`);
  const editorSlugById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of EDITOR_COMMANDS) m.set(c.id, c.slug);
    return m;
  }, []);
  const editorCommandLabel = (id: string): string =>
    t(`keybindings.editorCommand.${editorSlugById.get(id) ?? id}`);

  // Persistent, table-wide conflict maps (command-vs-command) — recomputed
  // whenever either effective table changes. App and editor namespaces are
  // graded independently.
  const appConflicts = useMemo(
    () => detectTableConflicts(effectiveBindings, isMac),
    [effectiveBindings],
  );
  const editorConflictBase = useMemo(
    () => editorConflictBindings(editorOverrides),
    [editorOverrides],
  );
  const editorConflicts = useMemo(
    () => detectTableConflicts(editorConflictBase, isMac),
    [editorConflictBase],
  );

  const conflictCount = appConflicts.size + editorConflicts.size;

  // Sections default collapsed; an active search/filter force-expands the
  // ones that have matches so results are never hidden behind a closed
  // section.
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
      const def = defaultDeclFor(command);
      return {
        command,
        label: t(`keybindings.command.${command}`),
        bindingLabel: bindingLabelFor(effectiveBindings, command),
        kind: def?.chord !== undefined ? "chord" : "primary",
        when: def?.when,
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
        bindingLabel: primary !== null ? acceleratorToLabel(primary, { isMac }) : null,
        kind: "primary",
        when: undefined,
        overridden: editorOverrides.some((o) => o.command === c.id),
        conflicts: editorConflicts.get(c.id) ?? [],
      };
    }).filter(matchesFilter);
  }, [t, editorOverrides, editorConflicts, matchesFilter]);

  const hasOverrides = overrides.length > 0 || editorOverrides.length > 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar: search + filters + reset all */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("keybindings.searchPlaceholder")}
          className={cn(
            "min-w-0 flex-1 rounded-(--radius-control) border border-border bg-background",
            "px-2 py-1 text-app-ui-sm text-foreground outline-none",
            "placeholder:text-muted-foreground focus:ring-1 focus:ring-ring",
          )}
        />
        <label className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-app-ui-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={modifiedOnly}
            onChange={(e) => setModifiedOnly(e.target.checked)}
          />
          {t("keybindings.modifiedOnly")}
        </label>
        <label
          className={cn(
            "flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-app-ui-sm",
            conflictCount > 0 ? "text-destructive" : "text-muted-foreground",
          )}
        >
          <input
            type="checkbox"
            checked={conflictsOnly}
            onChange={(e) => setConflictsOnly(e.target.checked)}
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

      {/* Application commands */}
      <CommandSection
        heading={t("keybindings.section.app")}
        rows={appRows}
        conflictCount={appConflicts.size}
        filterActive={filterActive}
        conflictBindings={effectiveBindings}
        commandLabel={appCommandLabel}
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

      {/* Editor (Monaco) commands */}
      <CommandSection
        heading={t("keybindings.section.editor")}
        description={t("keybindings.section.editorDescription")}
        rows={editorRows}
        conflictCount={editorConflicts.size}
        filterActive={filterActive}
        conflictBindings={editorConflictBase}
        commandLabel={editorCommandLabel}
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

// ---------------------------------------------------------------------------
// Section + row
// ---------------------------------------------------------------------------

interface CommandSectionProps {
  heading: string;
  description?: string;
  rows: Row[];
  /** Total conflicts in this section's namespace (shown on the collapsed summary). */
  conflictCount: number;
  /** A search/filter is active — force-expand when this section has matches. */
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
  // Default collapsed; the user can expand manually. An active filter with
  // matches forces it open regardless, so search results are never hidden.
  const [userOpen, setUserOpen] = useState(false);
  const forceOpen = filterActive && rows.length > 0;
  const open = forceOpen || userOpen;

  // Render the persistent conflict line for a row, naming the other side(s).
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
        // Ignore the programmatic toggle that fires when `forceOpen` drives
        // the element — only persist genuine user clicks.
        if (!forceOpen) setUserOpen(e.currentTarget.open);
      }}
      className="flex flex-col gap-1.5"
    >
      <summary
        className={cn(
          "flex cursor-pointer select-none items-center gap-1.5 rounded-(--radius-control) px-1 py-1",
          "text-app-body text-foreground hover:bg-[var(--state-hover-bg)]",
          // Replace the platform disclosure triangle with our own rotating chevron.
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
                commandLabel={commandLabel}
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

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

interface KeybindingRecorderProps {
  command: string;
  kind: BindingKind;
  when: string | undefined;
  bindings: readonly ConflictBinding[];
  hasBinding: boolean;
  commandLabel: (id: string) => string;
  /** value: [primary] for kind=primary, [leader, secondary] for chord. */
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
  commandLabel,
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

  // Record-time preview: includes shadow/system warnings against built-in
  // keys (which the persistent table view omits). Informational only — a
  // conflict never blocks the save (VSCode-aligned).
  const conflicts = useMemo(() => {
    if (!complete) return [];
    return detectConflicts({
      command,
      ...(kind === "chord"
        ? { chord: [captured[0] as string, captured[1] as string] as const }
        : { primary: captured[0] as string }),
      ...(when !== undefined ? { when } : {}),
      bindings,
      isMac,
    });
  }, [complete, captured, command, kind, when, bindings]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    // IME composition guard — same dual check as the dispatcher.
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

    const accel = eventToAccelerator(e.nativeEvent, isMac);
    if (accel === null) {
      setUnsupported(true);
      return;
    }
    setUnsupported(false);
    setCaptured((prev) => {
      if (kind === "primary") return [accel];
      // chord: fill slots; a third stroke restarts the capture.
      if (prev.length === 0 || prev.length >= 2) return [accel];
      return [prev[0] as string, accel];
    });
  }

  const capturedLabel =
    captured.length > 0
      ? captured.map((a) => acceleratorToLabel(a, { isMac })).join(" ")
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
        // Cancel when focus leaves the recorder entirely (clicking one of
        // the inline buttons keeps focus inside the container).
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
        let message: string;
        if (c.kind === "blocking" || c.kind === "overlap") {
          message = t(`keybindings.conflict.${c.kind}`, {
            command: c.command !== undefined ? commandLabel(c.command) : "?",
          });
        } else if (c.kind === "system") {
          message = t("keybindings.conflict.system", { note: c.reserved?.note ?? "" });
        } else {
          message = t("keybindings.conflict.shadow", {
            owner: c.reserved !== undefined ? t(`keybindings.owner.${c.reserved.source}`) : "?",
            note: c.reserved?.note ?? "",
          });
        }
        const severe = c.kind === "blocking" || c.kind === "system";
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
