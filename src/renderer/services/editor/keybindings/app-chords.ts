import type { CommandId } from "../../../../shared/keybindings/commands";
import type { KeybindingDecl } from "../../../../shared/keybindings/index";
import { executeCommand } from "../../../commands/registry";
import { isMonacoReady, requireMonaco } from "../runtime/monaco-singleton";
import { acceleratorToMonacoKeybinding } from "./apply";

export function appChordMonacoCommand(id: string): string {
  return `nexus.app.${id}`;
}

const appliedByCommand = new Map<string, { keybinding: number; rule: { dispose(): void } }>();
const registeredCommands = new Set<string>();

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

export function __resetAppliedAppChordsForTests(): void {
  appliedByCommand.clear();
  registeredCommands.clear();
}
