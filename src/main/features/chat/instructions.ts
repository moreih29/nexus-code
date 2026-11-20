import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentProfile } from "../../../shared/agent-profiles/profiles";
import {
  type AgentInstructions,
  ClaudeInstructionDigestSchema,
  mergeAgentInstructions,
} from "../../../shared/chat/instructions";
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

const claudeSessionId = z.string().uuid();

export interface ClaudeInstructionHook {
  sessionId?: string;
  phase: "start" | "prompt" | "restore";
}

interface ForkInstructions {
  sessionId: string;
  digest: string;
}

/** The id Claude uses for a resume, including when a profile supplies a transcript path. */
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

/** Carry the startup baseline and any fork snapshot across a desktop reconnect. */
export function claudeInstructionLaunch(text: string, fork?: ForkInstructions): string {
  return [randomUUID(), digest(text), ...(fork ? [fork.sessionId, fork.digest] : [])].join(":");
}

export function claudeInstructionLaunchState(launch: string) {
  const [, baseline, parentSessionId, parentDigest] = launch.split(":");
  const systemDigest = ClaudeInstructionDigestSchema.safeParse(baseline).data;
  if (!systemDigest) return undefined;

  const sessionId = instructionSessionId(parentSessionId);
  const digest = ClaudeInstructionDigestSchema.safeParse(parentDigest).data;
  const fork = sessionId && digest ? { sessionId, digest } : undefined;
  return { systemDigest, fork };
}

export function claudeInstructionUpdate(
  systemDigest: string,
  previous: string | undefined,
  current: string,
  restoring: boolean,
): { text: string; digest: string } | undefined {
  const next = digest(current);
  const last = previous ?? systemDigest;
  if (next === last && (!restoring || next === systemDigest)) return undefined;
  return {
    text: current ? `${replacement}\n\n${current}` : cleared,
    digest: next,
  };
}
