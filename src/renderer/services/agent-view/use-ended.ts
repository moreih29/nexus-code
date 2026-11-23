import { useEffect, useRef } from "react";
import { useShallow } from "zustand/shallow";
import type { SplitNode } from "@/engine";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { useTabsStore } from "../../state/stores/tabs";
import { useSessionActivity } from "../agent-sessions/use-family";
import type { Agents } from "./agents";
import {
  type EndedAgent,
  endedAgents,
  endedToRemove,
  noteSeen,
  type SeenAgents,
  sameEnded,
  withKept,
} from "./ended";
import { heldKeys, leafShowing, parseSessionKey, pruneKeys } from "./layout";

const NONE: ReadonlyMap<string, EndedAgent> = new Map();

export function useEndedAgents(
  agents: Agents,
  root: SplitNode,
  shown: boolean,
): ReadonlyMap<string, EndedAgent> {
  const held = heldKeys(root);
  const claudeIn = new Set<string>();
  for (const key of held) {
    const session = agents.byKey.get(key)?.session;
    if (session?.kind === "terminal" && session.agent === "claude") {
      claudeIn.add(session.workspaceId);
    }
  }
  const activity = useSessionActivity([...claudeIn].sort(), shown);
  const liveTerminals = useTabsStore(
    useShallow((s) =>
      held.filter((key) => {
        const at = parseSessionKey(key);
        const tab = at ? s.byWorkspace[at.workspaceId]?.[at.tabId] : undefined;
        return tab?.type === "terminal" && !tab.props.dead;
      }),
    ),
  );
  const stored = useAgentViewStore((s) => s.ended);

  const seen = useRef<SeenAgents>(NONE);
  const kept = useRef(NONE);
  seen.current = noteSeen(
    withKept(seen.current, stored),
    [...agents.byKey.values()].map((entry) => entry.session),
    (key) => activity.get(key)?.sessionId,
    kept.current,
  );
  const next = endedAgents(
    held,
    seen.current,
    (key) => agents.byKey.has(key),
    (key) => liveTerminals.includes(key),
  );
  if (!sameEnded(kept.current, next)) kept.current = next;
  const ended = kept.current;

  useEffect(() => {
    useAgentViewStore.getState().setEnded(ended);
  }, [ended]);

  useEffect(() => {
    const out = endedToRemove(ended, (key) => leafShowing(root, key) !== null, shown);
    if (out.length === 0) return;
    useAgentViewStore.getState().update((layout) => pruneKeys(layout, (key) => !out.includes(key)));
  }, [ended, root, shown]);

  return ended;
}
