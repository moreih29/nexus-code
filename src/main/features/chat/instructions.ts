import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentProfile } from "../../../shared/agent-profiles/profiles";
import {
  type AgentInstructions,
  ClaudeInstructionDigestSchema,
  mergeAgentInstructions,
  workspaceInstructionTarget,
} from "../../../shared/chat/instructions";
import type { WorkspaceMeta } from "../../../shared/types/workspace";

export function instructionsFor(
  config: AgentInstructions,
  profile: AgentProfile,
  workspaceId: string,
  workspaces: readonly WorkspaceMeta[],
  session?: string,
): string {
  return mergeAgentInstructions(config, {
    agent: profile.agent,
    profile,
    workspace: workspaceInstructionTarget(
      workspaces.find(({ id }) => id === workspaceId),
      workspaces,
    ),
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

const claudeSessionId = z.guid();

export interface ClaudeInstructionHook {
  sessionId?: string;
  phase: "start" | "prompt" | "restore";
}

interface ForkInstructions {
  sessionId: string;
  digest: string | null;
}

export function claudeResumeId(resume: string | undefined): string | undefined {
  return instructionSessionId(
    resume
      ?.split(/[\\/]/)
      .at(-1)
      ?.replace(/\.jsonl$/, ""),
  );
}

export function instructionSessionId(value: unknown): string | undefined {
  return claudeSessionId.safeParse(value).data;
}

export function claudeInstructionLaunch(text: string, fork?: ForkInstructions): string {
  return [randomUUID(), digest(text), ...(fork ? [fork.sessionId, fork.digest ?? ""] : [])].join(
    ":",
  );
}

export function claudeInstructionLaunchState(launch: string) {
  const [, baseline, parentSessionId, parentDigest] = launch.split(":");
  const systemDigest = ClaudeInstructionDigestSchema.safeParse(baseline).data;
  if (!systemDigest) return undefined;

  const sessionId = instructionSessionId(parentSessionId);
  const digest =
    parentDigest === "" ? null : ClaudeInstructionDigestSchema.safeParse(parentDigest).data;
  const fork = sessionId && digest !== undefined ? { sessionId, digest } : undefined;
  return { systemDigest, fork };
}

export function claudeInstructionUpdate(
  systemDigest: string,
  previous: string | null | undefined,
  current: string,
  restoring: boolean,
): { text: string; digest: string } | undefined {
  if (restoring && previous === null) return undefined;
  const next = digest(current);
  const last = previous === undefined ? systemDigest : previous;
  if (next === last && (!restoring || next === systemDigest)) return undefined;
  return {
    text: current ? `${replacement}\n\n${current}` : cleared,
    digest: next,
  };
}
