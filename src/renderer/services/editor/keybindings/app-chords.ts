/**
 * The app's chord bindings (Ctrl+K U, Ctrl+K Ctrl+W, …) as Monaco
 * keybindings.
 *
 * Monaco's own chords share the app's Ctrl+K leader: Ctrl+K Ctrl+C adds a
 * line comment, Ctrl+K Ctrl+0 folds all, and so on. On Win/Linux the
 * dispatcher therefore lets a chord leader through to Monaco while the
 * editor has focus (see keybindings/dispatcher.ts), and Monaco resolves
 * every chord there. This module binds the app's chords in Monaco, each to
 * a Monaco command that runs the app command, so they keep working in the
 * editor.
 *
 * Like apply.ts this is a reconciler: a rebound chord disposes the rule for
 * the old keystroke (an unbind rule would not remove a rule added this way)
 * and adds one for the new. The rules are harmless on macOS, where the
 * dispatcher keeps the ⌘K leader and Monaco never sees it.
 */

import type { CommandId } from "../../../../shared/keybindings/commands";
import type { KeybindingDecl } from "../../../../shared/keybindings/index";
import { executeCommand } from "../../../commands/registry";
import { isMonacoReady, requireMonaco } from "../runtime/monaco-singleton";
import { acceleratorToMonacoKeybinding } from "./apply";

/** Monaco command id that runs app command `id`. */
export function appChordMonacoCommand(id: string): string {
  return `nexus.app.${id}`;
}

/** The Monaco chord each app command is currently bound to, and the rule binding it. */
const appliedByCommand = new Map<string, { keybinding: number; rule: { dispose(): void } }>();
const registeredCommands = new Set<string>();

/**
 * Reconcile Monaco's keybindings with the chords in `bindings` (the
 * effective table). Emits only the delta versus the last call. No-op until
 * Monaco is initialized — editor-service init calls it again then.
 */
export function applyAppChordsToMonaco(bindings: readonly KeybindingDecl[]): void {
  if (!isMonacoReady()) return;
  const monaco = requireMonaco();

  const want = new Map<string, number>();
  for (const decl of bindings) {
    if (decl.chord === undefined || want.has(decl.command)) continue;
    const first = acceleratorToMonacoKeybinding(monaco, decl.chord[0]);
    const second = acceleratorToMonacoKeybinding(monaco, decl.chord[1]);
    if (first === null || second === null) continue;
    want.set(decl.command, monaco.KeyMod.chord(first, second));
  }

  for (const [id, prev] of appliedByCommand) {
    if (want.get(id) === prev.keybinding) continue;
    prev.rule.dispose();
    appliedByCommand.delete(id);
  }
  for (const [id, keybinding] of want) {
    if (appliedByCommand.has(id)) continue;
    const command = appChordMonacoCommand(id);
    if (!registeredCommands.has(command)) {
      monaco.editor.registerCommand(command, () => executeCommand(id as CommandId));
      registeredCommands.add(command);
    }
    const rule = monaco.editor.addKeybindingRule({ keybinding, command });
    appliedByCommand.set(id, { keybinding, rule });
  }
}

/** Test-only: forget what has been applied so a fresh reconcile starts clean. */
export function __resetAppliedAppChordsForTests(): void {
  appliedByCommand.clear();
  registeredCommands.clear();
}
