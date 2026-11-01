/**
 * Where a browser tab's pick button sends the element the user picked: the
 * agent sessions of the tab's workspace, and the text as their terminal
 * takes it. Pure, so the choices and the text can be tested alone.
 */

import { type AgentSession, buildFamily, type FamilyInput } from "../sessions/model";

/** The live agent sessions of `input.workspaceId` itself, not of its tasks or root. */
export function pickTargets(input: FamilyInput): AgentSession[] {
  const family = buildFamily(input);
  const own = family?.worktrees.find((w) => w.workspace.id === input.workspaceId);
  return (own?.sessions ?? []).filter((s) => s.state !== "exited");
}

/**
 * `text` as pasted into a terminal's prompt, so it waits there for the
 * user's own words. With bracketed paste on, the lines stay lines, and a
 * last line break leaves the cursor below them. Without it a line break
 * would act as Enter, so the lines are joined into one.
 */
export function pasteForTerminal(text: string, bracketedPaste: boolean): string {
  if (bracketedPaste) return `${text}\n`;
  const parts = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return `${parts.join(" | ")} `;
}
