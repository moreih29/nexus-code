/**
 * Where a browser tab's pick button sends the element the user picked: the
 * agent sessions of the tab's workspace, and the text as their terminal
 * takes it. Pure, so the choices and the text can be tested alone.
 */

import { agentFromProgram } from "../../../shared/sessions/agent-state";
import { type AgentSession, buildFamily, type FamilyInput } from "../sessions/model";

/**
 * The live agent sessions of `input.workspaceId` itself, not of its tasks
 * or root. Only a terminal Claude's hooks report on, or whose foreground
 * program is an agent, counts: a title or a notification can come from a
 * shell, which would take the paste as a command line.
 */
export function pickTargets(input: FamilyInput): AgentSession[] {
  const family = buildFamily(input);
  const own = family?.worktrees.find((w) => w.workspace.id === input.workspaceId);
  const claude = input.claudeByWorkspace[input.workspaceId] ?? {};
  return (own?.sessions ?? []).filter(
    (s) =>
      s.state !== "exited" &&
      (claude[s.tabId] !== undefined ||
        agentFromProgram(input.activity.get(s.key)?.program) !== undefined),
  );
}

export interface TargetLabel {
  readonly key: string;
  readonly title: string;
  /** What else tells it apart: its agent, and the last prompt or message. */
  readonly detail: string;
}

const DETAIL_MAX = 40;

/**
 * How the menu names each target. Sessions are told apart by their agent and
 * what they were last told or said; rows that would still read alike are
 * numbered in the menu's order.
 */
export function targetLabels(sessions: readonly AgentSession[]): TargetLabel[] {
  const labels = sessions.map((s) => {
    const agent = s.agent && !s.title.toLowerCase().includes(s.agent) ? s.agent : "";
    const said = (s.prompt ?? s.message ?? "").replace(/\s+/g, " ").trim();
    const snippet = said.length > DETAIL_MAX ? `${said.slice(0, DETAIL_MAX - 1)}…` : said;
    return { key: s.key, title: s.title, detail: [agent, snippet].filter(Boolean).join(" · ") };
  });
  const reading = (l: TargetLabel) => `${l.title}\n${l.detail}`;
  const seen = new Map<string, number>();
  return labels.map((l) => {
    const same = reading(l);
    if (labels.filter((other) => reading(other) === same).length < 2) return l;
    const n = (seen.get(same) ?? 0) + 1;
    seen.set(same, n);
    return { ...l, title: `${l.title} (${n})` };
  });
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * `text` as pasted into a terminal's prompt, so it waits there for the
 * user's own words. Control characters a page may have put in it are
 * dropped first, so it cannot end a bracketed paste early or press keys.
 * With bracketed paste on, the lines stay lines, and a last line break
 * leaves the cursor below them. Without it a line break would act as Enter
 * and a tab as completion, so the lines are joined into one.
 */
export function pasteForTerminal(text: string, bracketedPaste: boolean): string {
  const clean = text.replace(CONTROLS, "");
  if (bracketedPaste) return `${clean}\n`;
  const parts = clean
    .split("\n")
    .map((line) => line.replace(/\t/g, " ").trim())
    .filter((line) => line !== "");
  return `${parts.join(" | ")} `;
}
