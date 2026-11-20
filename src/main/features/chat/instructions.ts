import { createHash, randomUUID } from "node:crypto";
import type { AgentProfile } from "../../../shared/agent-profiles/profiles";
import { type AgentInstructions, mergeAgentInstructions } from "../../../shared/chat/instructions";
import type { WorkspaceMeta } from "../../../shared/types/workspace";

export function instructionsFor(
  config: AgentInstructions,
  profile: AgentProfile,
  workspace: WorkspaceMeta | undefined,
  session?: string,
): string {
  return mergeAgentInstructions(config, {
    agent: profile.agent,
    profile,
    workspace,
    session,
  });
}

const replacement =
  "Follow the current NexusCode instructions below in place of any earlier NexusCode instructions.";
const cleared =
  "NexusCode instructions were cleared. Disregard all earlier NexusCode instructions for this conversation.";

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Identify a Claude launch and its system prompt, even if the desktop reconnects. */
export function claudeInstructionLaunch(text: string): string {
  return `${randomUUID()}:${digest(text)}`;
}

export function claudeInstructionUpdate(
  launch: string,
  previous: string | undefined,
  current: string,
  compacting: boolean,
): { text: string; digest: string } | undefined {
  const baseline = launch.split(":")[1];
  if (!baseline || !/^[a-f0-9]{64}$/.test(baseline)) return undefined;
  const next = digest(current);
  const last = previous ?? baseline;
  if (next === last && (!compacting || next === baseline)) return undefined;
  return {
    text: current ? `${replacement}\n\n${current}` : cleared,
    digest: next,
  };
}
