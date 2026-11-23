import { z } from "zod";
import type { CommandId } from "./commands";
import type { KeybindingDecl } from "./index";
import { parseAccelerator } from "./keybinding-parse";
import { isPlatformOnlyWhen } from "./keybinding-when";

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
  command: z.string().min(1).max(128),
  primary: AcceleratorStringSchema.nullable().optional(),
  chord: z.tuple([AcceleratorStringSchema, AcceleratorStringSchema]).nullable().optional(),
});

export const KeybindingOverridesSchema = z.array(KeybindingOverrideSchema).max(256);

export type KeybindingOverride = z.infer<typeof KeybindingOverrideSchema>;

export function applyKeybindingOverrides(
  defaults: readonly KeybindingDecl[],
  overrides: readonly KeybindingOverride[] | undefined,
  knownCommands: ReadonlySet<string>,
): KeybindingDecl[] {
  if (overrides === undefined || overrides.length === 0) return [...defaults];

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

    const kept: KeybindingDecl = { command: decl.command };
    const replaced: KeybindingDecl = { command: decl.command };

    if (decl.primary !== undefined) {
      if (ov.primary === undefined) {
        kept.primary = decl.primary;
      } else if (ov.primary !== null && !primaryEmitted.has(decl.command)) {
        replaced.primary = ov.primary;
        primaryEmitted.add(decl.command);
      }
    }

    if (decl.chord !== undefined) {
      if (ov.chord === undefined) {
        kept.chord = decl.chord;
      } else if (ov.chord !== null && !chordEmitted.has(decl.command)) {
        replaced.chord = ov.chord;
        chordEmitted.add(decl.command);
      }
    }

    const replacedWhen = inheritedWhen(decl.when);
    if (replacedWhen === decl.when) {
      pushBinding(out, { ...kept, ...replaced }, decl.when);
    } else {
      pushBinding(out, kept, decl.when);
      pushBinding(out, replaced, replacedWhen);
    }
  }

  for (const [command, ov] of byCommand) {
    const inherited = inheritedWhen(defaults.find((d) => d.command === command)?.when);
    const extra: KeybindingDecl = { command: command as CommandId };
    if (inherited !== undefined) extra.when = inherited;

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

export function inheritedWhen(when: string | undefined): string | undefined {
  return when !== undefined && isPlatformOnlyWhen(when) ? undefined : when;
}

function pushBinding(out: KeybindingDecl[], decl: KeybindingDecl, when: string | undefined): void {
  if (decl.primary === undefined && decl.chord === undefined) return;
  out.push(when === undefined ? decl : { ...decl, when });
}

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

export function removeOverride(
  overrides: readonly KeybindingOverride[],
  command: string,
): KeybindingOverride[] {
  return overrides.filter((o) => o.command !== command);
}
