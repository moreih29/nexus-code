import { useEffect, useMemo, useState } from "react";
import type { AgentRun } from "../../../shared/claude/activity";
import { ipcCallResult } from "../../ipc/client";
import { subagentLog } from "./claude/history";
import { type ChatItem, type ChatModel, emptyModel } from "./model";
import { RUN_READ_INTERVAL_MS } from "./print-run-transcript";

export interface SubagentConversation {
  model: ChatModel;
  items: ChatItem[];
  truncated: boolean;
}

export function subagentConversation(
  agent: Pick<AgentRun, "id" | "prompt" | "start">,
  lines: readonly unknown[],
  truncated: boolean,
): SubagentConversation | null {
  const log = subagentLog(lines, agent.id);
  if (log.items.length === 0) return null;
  const prompt: ChatItem[] = agent.prompt
    ? [
        {
          kind: "user",
          key: `prompt-${agent.id}`,
          text: agent.prompt,
          images: [],
          state: "taken",
          at: agent.start,
        },
      ]
    : [];
  return {
    model: { ...emptyModel(), tools: log.tools },
    items: [...prompt, ...log.items],
    truncated,
  };
}

interface Read {
  key: string;
  lines: readonly unknown[];
  truncated: boolean;
}

export function useSubagentConversation(
  workspaceId: string,
  sessionId: string | undefined,
  profileId: string | undefined,
  agent: AgentRun,
  enabled: boolean,
): SubagentConversation | null {
  const running = agent.end === undefined;
  const key = `${workspaceId}\n${sessionId ?? ""}\n${agent.id}`;
  const [read, setRead] = useState<Read | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled || !running) return;
    const timer = setInterval(() => setTick((n) => n + 1), RUN_READ_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, running]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick and running ask for another read
  useEffect(() => {
    if (!enabled || !sessionId) return;
    let stale = false;
    void ipcCallResult("chat", "subagentTranscript", {
      workspaceId,
      sessionId,
      agentId: agent.id,
      ...(profileId ? { profileId } : {}),
    }).then((result) => {
      if (stale || !result.ok || !result.value.found) return;
      setRead({ key, lines: result.value.lines, truncated: result.value.truncated });
    });
    return () => {
      stale = true;
    };
  }, [enabled, workspaceId, sessionId, profileId, agent.id, key, tick, running]);

  const { id, prompt, start } = agent;
  return useMemo(
    () =>
      read && read.key === key
        ? subagentConversation({ id, prompt, start }, read.lines, read.truncated)
        : null,
    [read, key, id, prompt, start],
  );
}
