import { useEffect, useState } from "react";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import type { AgentSession } from "../agent-sessions/model";
import { historyModel } from "../chat/claude/history";
import { TranscriptPages } from "../chat/claude/transcript-pages";
import { CodexController } from "../chat/codex/controller";
import { type ConversationResolution, tabLinkTarget } from "./conversation";

type StoredTurnTarget = readonly [
  agent: "claude" | "codex",
  workspaceId: string,
  cwd: string,
  profileId: string | null,
  sessionId: string,
];

export function storedTurnTarget(
  target: ConversationResolution,
  session: Pick<AgentSession, "hasTurns" | "state"> | undefined,
): StoredTurnTarget | undefined {
  if (target.kind !== "open" && target.kind !== "moved") return;
  if (session && (session.hasTurns || session.state !== "idle")) return;
  // Use the restored tab's current ID and profile. A link may remember a session
  // from before the user cleared or switched the tab.
  const {
    workspaceId,
    cwd,
    profileId,
    session: sessionId,
  } = tabLinkTarget(target.workspace.id, target.tab);
  if (sessionId) return [target.tab.type, workspaceId, cwd, profileId ?? null, sessionId];
}

async function claudeHasStoredTurns([, workspaceId, , profile, sessionId]: StoredTurnTarget) {
  const args = { workspaceId, sessionId, profileId: profile ?? undefined };
  const first = unwrapIpcResult(await ipcCallResult("chat", "transcriptPage", args));
  const hasMessage = (history: ReturnType<typeof historyModel>) =>
    history.items.some((item) => item.kind === "user" || item.kind === "assistant");
  if (!first.found) return false;
  if (!first.snapshot) return hasMessage(historyModel(first.lines));
  const pages = new TranscriptPages(first, first.snapshot);
  while (true) {
    if (!pages.hasPartialRow && hasMessage(pages.project())) return true;
    const cursor = pages.cursor;
    if (!cursor) return false;
    pages.prepend(
      unwrapIpcResult(await ipcCallResult("chat", "transcriptPage", { ...args, cursor })),
    );
  }
}

async function probeStoredTurns(targets: readonly StoredTurnTarget[]): Promise<Set<string>> {
  const found = new Set<string>();
  const codex = new Map<string, StoredTurnTarget[]>();
  const reads: Promise<void>[] = [];
  for (const target of targets) {
    const [agent, workspaceId, cwd, profileId] = target;
    if (agent === "claude") {
      reads.push(
        claudeHasStoredTurns(target).then((hasTurns) => {
          if (hasTurns) found.add(JSON.stringify(target));
        }),
      );
    } else {
      const key = JSON.stringify([workspaceId, cwd, profileId]);
      const group = codex.get(key);
      if (group) group.push(target);
      else codex.set(key, [target]);
    }
  }
  for (const group of codex.values()) {
    const [, workspaceId, cwd, profileId] = group[0];
    reads.push(
      CodexController.savedThreadsWithTurns(
        { workspaceId, cwd, profileId: profileId ?? undefined },
        group.map((target) => target[4]),
      ).then((threads) => {
        const ids = new Set(threads);
        for (const target of group) {
          if (ids.has(target[4])) found.add(JSON.stringify(target));
        }
      }),
    );
  }
  await Promise.allSettled(reads);
  return found;
}

const MISSING_TURNS_TTL = 30_000;
const storedTurns = new Map<string, { result: Promise<boolean>; expiresAt: number }>();

function sessionKey([agent, , , profileId, sessionId]: StoredTurnTarget) {
  return JSON.stringify([agent, sessionId, profileId]);
}

/** Checks saved transcripts while leaving the actual conversation tabs cold. */
export async function readStoredTurns(targets: readonly StoredTurnTarget[]): Promise<Set<string>> {
  const now = Date.now();
  const missing = new Map<string, StoredTurnTarget>();
  for (const target of targets) {
    const key = sessionKey(target);
    const cached = storedTurns.get(key);
    if (!cached || cached.expiresAt <= now) missing.set(key, target);
  }
  if (missing.size) {
    const probe = probeStoredTurns([...missing.values()]);
    for (const [key, target] of missing) {
      const entry = {
        expiresAt: Infinity,
        result: probe.then((found) => {
          const hasTurns = found.has(JSON.stringify(target));
          if (!hasTurns) entry.expiresAt = Date.now() + MISSING_TURNS_TTL;
          return hasTurns;
        }),
      };
      storedTurns.set(key, entry);
    }
  }

  const found = new Set<string>();
  await Promise.all(
    targets.map(async (target) => {
      if (await storedTurns.get(sessionKey(target))?.result) found.add(JSON.stringify(target));
    }),
  );
  return found;
}

export function useStoredTurns(targets: readonly StoredTurnTarget[], visible: boolean) {
  const keys = [...new Set(targets.map((target) => JSON.stringify(target)))].sort();
  const request = JSON.stringify(keys);
  const [saved, setSaved] = useState<{ request: string; found: Set<string> }>();
  useEffect(() => {
    if (!visible || request === "[]") return;
    let current = true;
    const targets = (JSON.parse(request) as string[]).map(
      (key) => JSON.parse(key) as StoredTurnTarget,
    );
    void readStoredTurns(targets).then((found) => {
      if (current) setSaved({ request, found });
    });
    return () => {
      current = false;
    };
  }, [request, visible]);
  return saved?.request === request ? saved.found : undefined;
}
