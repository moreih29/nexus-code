import { expect, spyOn, test } from "bun:test";
import * as ipc from "../../../../../src/renderer/ipc/client";
import { CodexController } from "../../../../../src/renderer/services/chat/codex/controller";
import type { ConversationResolution } from "../../../../../src/renderer/services/notes/conversation";
import {
  readStoredTurns,
  storedTurnTarget,
} from "../../../../../src/renderer/services/notes/stored-turns";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

test("checks the restored tab's current session without treating an ID alone as a turn", () => {
  const workspace = { id: "workspace" } as WorkspaceMeta;
  const tab = {
    id: "restored",
    type: "codex" as const,
    title: "Thread",
    defaultTitle: "Codex",
    isPinned: false,
    isPreview: false,
    props: { cwd: "/repo", threadId: "current", profileId: "profile" },
  };
  const target: ConversationResolution = { kind: "moved", workspace, tab };
  expect(storedTurnTarget(target, { state: "idle", hasTurns: false })).toEqual([
    "codex",
    workspace.id,
    "/repo",
    "profile",
    "current",
  ]);
  expect(storedTurnTarget(target, { state: "idle", hasTurns: true })).toBeUndefined();
  expect(storedTurnTarget(target, { state: "running", hasTurns: false })).toBeUndefined();
  expect(
    storedTurnTarget({ ...target, tab: { ...tab, props: { cwd: "/repo" } } }, undefined),
  ).toBeUndefined();
});

test("reads saved Claude pages and exact Codex threads without counting metadata-only sessions", async () => {
  const transcript = spyOn(ipc, "ipcCallResult").mockImplementation(
    async (_channel, _method, args) => {
      const { sessionId, cursor } = args as { sessionId: string; cursor?: string };
      const snapshot = `snapshot-${sessionId}`;
      if (sessionId === "empty" || !cursor) {
        return {
          ok: true,
          value: {
            found: true,
            truncated: false,
            snapshot,
            positions: [2],
            lines: [{ type: "custom-title", customTitle: "Saved name" }],
            ...(sessionId === "empty" ? {} : { cursor: "older" }),
          },
        };
      }
      return {
        ok: true,
        value: {
          found: true,
          truncated: false,
          snapshot,
          positions: [1],
          lines: [{ type: "user", message: { role: "user", content: "Past prompt" } }],
        },
      };
    },
  );
  const codex = spyOn(CodexController, "savedThreadsWithTurns").mockResolvedValue(["saved"]);
  const targets = [
    ["claude", "workspace", "/repo", "profile", "old-session"],
    ["claude", "workspace", "/repo", "profile", "empty"],
    ["codex", "workspace", "/repo", null, "saved"],
    ["codex", "workspace", "/repo", null, "unwritten"],
  ] as const;
  try {
    const result = await readStoredTurns(targets);
    expect(result).toEqual(new Set([JSON.stringify(targets[0]), JSON.stringify(targets[2])]));
    expect(transcript).toHaveBeenCalledWith("chat", "transcriptPage", {
      workspaceId: "workspace",
      sessionId: "old-session",
      profileId: "profile",
      cursor: "older",
    });
    expect(codex).toHaveBeenCalledTimes(1);
    expect(codex).toHaveBeenCalledWith(
      { workspaceId: "workspace", cwd: "/repo", profileId: undefined },
      ["saved", "unwritten"],
    );
  } finally {
    transcript.mockRestore();
    codex.mockRestore();
  }
});
