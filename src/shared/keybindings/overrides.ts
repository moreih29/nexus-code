/**
 * User keybinding overrides — schema + pure application.
 *
 * Persistence model: the DEFAULT table (`KEYBINDINGS`) is immutable
 * code; user customization is stored as a DELTA (`KeybindingOverride[]`
 * in appState). Effective bindings = `applyKeybindingOverrides(defaults,
 * overrides)`. This keeps version migration trivial — when defaults
 * change between app releases, overrides keyed by command id stay
 * valid, and overrides for commands that no longer exist are silently
 * dropped at apply time (never at parse time, so a stale state.json
 * can't fail validation wholesale).
 *
 * Field semantics per override entry (at most one entry per command —
 * later entries win):
 *   - `primary: "Accel"`  → replace ALL default primary bindings of the
 *                           command with this single accelerator.
 *   - `primary: null`     → unbind (remove all default primaries).
 *   - `primary` absent    → defaults untouched.
 *   - `chord` mirrors the same tri-state for chord bindings.
 *
 * The replaced binding INHERITS the `when` scope of the command's first
 * default declaration. `when` is intentionally not user-editable in v1:
 * scopes like `fileTreeFocus && !inputFocus` are data-loss guards
 * (file.delete) and per-surface routers (browserTabActive) — letting a
 * recorder UI silently strip them would reintroduce the exact bug
 * classes the scopes exist to prevent.
 */

import { z } from "zod";
import type { CommandId } from "./commands";
import type { KeybindingDecl } from "./index";
import { parseAccelerator } from "./keybinding-parse";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * An accelerator that our parser accepts. Validated with the real
 * parser (not a regex) so the schema can never admit a string the
 * dispatcher would later throw on at compile time.
 */
export const AcceleratorStringSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (value) => {
      try {
        parseAccelerator(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: "unparseable accelerator string" },
  );

export const KeybindingOverrideSchema = z.object({
  // Plain string, NOT CommandIdSchema: an override written by a newer
  // (or older) app version may reference a command this build doesn't
  // know. Rejecting it here would fail the whole appState parse; we
  // accept it and drop it at apply time instead.
  command: z.string().min(1).max(128),
  primary: AcceleratorStringSchema.nullable().optional(),
  chord: z.tuple([AcceleratorStringSchema, AcceleratorStringSchema]).nullable().optional(),
});

export const KeybindingOverridesSchema = z.array(KeybindingOverrideSchema).max(256);

export type KeybindingOverride = z.infer<typeof KeybindingOverrideSchema>;

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

/**
 * Compute the effective binding table from defaults + user overrides.
 *
 * Ordering is preserved — a replacement binding is emitted at the
 * position of the command's FIRST default declaration of the same kind
 * (primary/chord), because the resolver returns the first match in
 * table order and that priority is part of the dispatch semantics
 * (e.g. browser ⌘R before files.refresh ⌘R relies on disjoint `when`s,
 * not order, but order remains the tiebreaker for true duplicates).
 * Overrides for commands with no default declaration are appended at
 * the end.
 *
 * Pure: never mutates inputs; safe to call on every store update.
 */
export function applyKeybindingOverrides(
  defaults: readonly KeybindingDecl[],
  overrides: readonly KeybindingOverride[] | undefined,
  knownCommands: ReadonlySet<string>,
): KeybindingDecl[] {
  if (overrides === undefined || overrides.length === 0) return [...defaults];

  // Last entry per command wins; unknown commands are dropped.
  const byCommand = new Map<string, KeybindingOverride>();
  for (const o of overrides) {
    if (knownCommands.has(o.command)) byCommand.set(o.command, o);
  }
  if (byCommand.size === 0) return [...defaults];

  const out: KeybindingDecl[] = [];
  const primaryEmitted = new Set<string>();
  const chordEmitted = new Set<string>();

  for (const decl of defaults) {
    const ov = byCommand.get(decl.command);
    if (ov === undefined) {
      out.push(decl);
      continue;
    }

    const next: KeybindingDecl = { command: decl.command };
    if (decl.when !== undefined) next.when = decl.when;

    if (decl.primary !== undefined) {
      if (ov.primary === undefined) {
        next.primary = decl.primary; // untouched
      } else if (ov.primary !== null && !primaryEmitted.has(decl.command)) {
        next.primary = ov.primary; // replacement, once, at first slot
        primaryEmitted.add(decl.command);
      }
      // ov.primary === null → unbound; subsequent duplicates also dropped.
    }

    if (decl.chord !== undefined) {
      if (ov.chord === undefined) {
        next.chord = decl.chord;
      } else if (ov.chord !== null && !chordEmitted.has(decl.command)) {
        next.chord = ov.chord;
        chordEmitted.add(decl.command);
      }
    }

    if (next.primary !== undefined || next.chord !== undefined) {
      out.push(next);
    }
  }

  // Overrides that add a binding to a command with no default decl of
  // that kind (e.g. a chord-only command gaining a primary, or a
  // command that ships unbound).
  for (const [command, ov] of byCommand) {
    const inheritedWhen = defaults.find((d) => d.command === command)?.when;
    const extra: KeybindingDecl = { command: command as CommandId };
    if (inheritedWhen !== undefined) extra.when = inheritedWhen;

    let hasAny = false;
    if (ov.primary != null && !primaryEmitted.has(command)) {
      const hadDefaultPrimary = defaults.some(
        (d) => d.command === command && d.primary !== undefined,
      );
      if (!hadDefaultPrimary) {
        extra.primary = ov.primary;
        hasAny = true;
      }
    }
    if (ov.chord != null && !chordEmitted.has(command)) {
      const hadDefaultChord = defaults.some((d) => d.command === command && d.chord !== undefined);
      if (!hadDefaultChord) {
        extra.chord = ov.chord;
        hasAny = true;
      }
    }
    if (hasAny) out.push(extra);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Override-list editing helpers (used by the renderer store / settings UI)
// ---------------------------------------------------------------------------

/**
 * Upsert one command's override into the list, merging field-wise with
 * any existing entry. Passing `undefined` for a field leaves the
 * existing value; `null` records an explicit unbind. Returns a new
 * array (inputs untouched). An entry whose fields all end up
 * `undefined` is removed entirely (back to defaults).
 */
export function upsertOverride(
  overrides: readonly KeybindingOverride[],
  patch: KeybindingOverride,
): KeybindingOverride[] {
  const existing = overrides.find((o) => o.command === patch.command);
  const merged: KeybindingOverride = {
    command: patch.command,
    primary: patch.primary !== undefined ? patch.primary : existing?.primary,
    chord: patch.chord !== undefined ? patch.chord : existing?.chord,
  };
  const rest = overrides.filter((o) => o.command !== patch.command);
  if (merged.primary === undefined && merged.chord === undefined) return rest;
  return [...rest, merged];
}

/** Remove a command's override (restore its defaults). Returns a new array. */
export function removeOverride(
  overrides: readonly KeybindingOverride[],
  command: string,
): KeybindingOverride[] {
  return overrides.filter((o) => o.command !== command);
}
