/**
 * The agent view's ended agents (ended.ts), kept as the panels and the
 * agents change, and over a restart in the store, and let go of as the user
 * moves on.
 */

import { useEffect, useRef } from "react";
import type { SplitNode } from "@/engine";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { useTabsStore } from "../../state/stores/tabs";
import { useSessionActivity } from "../sessions/use-family";
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

/** The ended agents the panels hold, by session key; read while `shown`. */
export function useEndedAgents(
  agents: Agents,
  root: SplitNode,
  shown: boolean,
): ReadonlyMap<string, EndedAgent> {
  const held = heldKeys(root);
  // Claude's session id, read while it runs in a terminal a panel holds.
  const claudeIn = new Set<string>();
  for (const key of held) {
    const session = agents.byKey.get(key)?.session;
    if (session?.kind === "terminal" && session.agent === "claude") {
      claudeIn.add(session.workspaceId);
    }
  }
  const activity = useSessionActivity([...claudeIn].sort(), shown);
  const tabs = useTabsStore((s) => s.byWorkspace);
  // What the store keeps: what a panel showed before a restart, once it is
  // restored, and what this wrote since.
  const stored = useAgentViewStore((s) => s.ended);

  const seen = useRef<SeenAgents>(NONE);
  seen.current = noteSeen(
    withKept(seen.current, stored),
    [...agents.byKey.values()].map((entry) => entry.session),
    (key) => activity.get(key)?.sessionId,
  );
  const next = endedAgents(
    held,
    seen.current,
    (key) => agents.byKey.has(key),
    (key) => {
      const at = parseSessionKey(key);
      const tab = at ? tabs[at.workspaceId]?.[at.tabId] : undefined;
      return tab?.type === "terminal" && !tab.props.dead;
    },
  );
  const kept = useRef(NONE);
  if (!sameEnded(kept.current, next)) kept.current = next;
  const ended = kept.current;

  useEffect(() => {
    useAgentViewStore.getState().setEnded(ended);
  }, [ended]);

  // Moving on lets the terminal go; it stays in its workspace.
  useEffect(() => {
    const out = endedToRemove(ended, (key) => leafShowing(root, key) !== null, shown);
    if (out.length === 0) return;
    useAgentViewStore.getState().update((layout) => pruneKeys(layout, (key) => !out.includes(key)));
  }, [ended, root, shown]);

  return ended;
}
