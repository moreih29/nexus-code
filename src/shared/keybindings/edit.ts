import { ALL_COMMAND_IDS, COMMANDS, type CommandId } from "./commands";
import { type ConflictBinding, detectConflicts, type KeybindingConflict } from "./conflicts";
import { EDITOR_COMMANDS } from "./editor-commands";
import { type AcceleratorString, KEYBINDINGS } from "./index";
import { inheritedWhen, type KeybindingOverride } from "./overrides";

export type BindableCommandId = Exclude<CommandId, typeof COMMANDS.updatesCheck>;

export const BINDABLE_COMMANDS = ALL_COMMAND_IDS.filter(
  (id): id is BindableCommandId => id !== COMMANDS.updatesCheck,
);

export type BindingKind = "primary" | "chord";

export interface BindingShape {
  readonly kind: BindingKind;
  readonly when: string | undefined;
}

export function appBindingShape(command: CommandId): BindingShape {
  const decl = KEYBINDINGS.find((b) => b.command === command);
  return {
    kind: decl?.chord !== undefined ? "chord" : "primary",
    when: inheritedWhen(decl?.when),
  };
}

export function editorEffectivePrimary(
  overrides: readonly KeybindingOverride[],
  id: string,
  fallback: string | undefined,
): string | null {
  const override = overrides.find((o) => o.command === id);
  if (override === undefined || override.primary === undefined) return fallback ?? null;
  return override.primary;
}

export function editorConflictBindings(
  overrides: readonly KeybindingOverride[],
): ConflictBinding[] {
  const out: ConflictBinding[] = [];
  for (const c of EDITOR_COMMANDS) {
    const primary = editorEffectivePrimary(overrides, c.id, c.defaultPrimary);
    if (primary !== null) out.push({ command: c.id, primary });
  }
  return out;
}

export interface ProposedBinding extends BindingShape {
  readonly command: string;
  readonly keys: readonly AcceleratorString[];
  readonly bindings: readonly ConflictBinding[];
  readonly isMac: boolean;
}

export function proposedBindingConflicts({
  command,
  kind,
  when,
  keys,
  bindings,
  isMac,
}: ProposedBinding): KeybindingConflict[] {
  return detectConflicts({
    command,
    ...(kind === "chord"
      ? { chord: [keys[0] as string, keys[1] as string] as const }
      : { primary: keys[0] as string }),
    ...(when !== undefined ? { when } : {}),
    bindings,
    isMac,
  });
}

export function isSevereConflict(conflict: KeybindingConflict): boolean {
  return conflict.kind === "blocking" || conflict.kind === "system";
}
