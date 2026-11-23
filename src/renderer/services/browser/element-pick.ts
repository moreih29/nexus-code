import { agentFromProgram } from "../../../shared/sessions/agent-state";
import { type AgentSession, buildFamily, type FamilyInput } from "../agent-sessions/model";

export function pickTargets(input: FamilyInput): AgentSession[] {
  const family = buildFamily(input);
  const own = family?.worktrees.find((w) => w.workspace.id === input.workspaceId);
  const claude = input.claudeByWorkspace[input.workspaceId] ?? {};
  return (own?.sessions ?? []).filter(
    (s) =>
      s.kind === "terminal" &&
      s.state !== "exited" &&
      (claude[s.tabId] !== undefined ||
        agentFromProgram(input.activity.get(s.key)?.program) !== undefined),
  );
}

export interface TargetLabel {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
}

const DETAIL_MAX = 40;

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

export function pasteForTerminal(text: string, bracketedPaste: boolean): string {
  const clean = text.replace(CONTROLS, "");
  if (bracketedPaste) return `${clean}\n`;
  const parts = clean
    .split("\n")
    .map((line) => line.replace(/\t/g, " ").trim())
    .filter((line) => line !== "");
  return `${parts.join(" | ")} `;
}
