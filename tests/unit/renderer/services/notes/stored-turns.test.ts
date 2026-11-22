import { expect, spyOn, test } from "bun:test";
import { act, createElement } from "react";
import * as ipc from "../../../../../src/renderer/ipc/client";
import { CodexController } from "../../../../../src/renderer/services/chat/codex/controller";
import type { ConversationResolution } from "../../../../../src/renderer/services/notes/conversation";
import {
  readStoredTurns,
  storedTurnTarget,
  useStoredTurns,
} from "../../../../../src/renderer/services/notes/stored-turns";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";
import { withTestDom } from "../../../../helpers/test-dom";

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
    const [result, concurrent] = await Promise.all([
      readStoredTurns(targets),
      readStoredTurns(targets),
    ]);
    expect(result).toEqual(new Set([JSON.stringify(targets[0]), JSON.stringify(targets[2])]));
    expect(concurrent).toEqual(result);
    // A restored workspace or folder may have moved while keeping the same session.
    const moved = targets.map(
      ([agent, , , profile, id]) => [agent, "moved-workspace", "/moved", profile, id] as const,
    );
    expect(await readStoredTurns(moved)).toEqual(
      new Set([JSON.stringify(moved[0]), JSON.stringify(moved[2])]),
    );
    expect(transcript).toHaveBeenCalledTimes(3);
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

test("hiding, showing and reopening a note reuses its saved turns", async () => {
  const targets = [["codex", "workspace", "/repo", null, "reopened-thread"]] as const;
  function Panel({ visible }: { visible: boolean }) {
    return createElement("span", {}, useStoredTurns(targets, visible)?.size);
  }
  const codex = spyOn(CodexController, "savedThreadsWithTurns").mockResolvedValue([
    "reopened-thread",
  ]);
  try {
    await withTestDom(async (host, root) => {
      await act(async () => root.render(createElement(Panel, { visible: false })));
      expect(codex).not.toHaveBeenCalled();
      await act(async () => root.render(createElement(Panel, { visible: true })));
      expect(host.textContent).toBe("1");
      await act(async () => root.render(createElement(Panel, { visible: false })));
      await act(async () => root.render(createElement(Panel, { visible: true })));
      await act(async () => root.render(null));
      await act(async () => root.render(createElement(Panel, { visible: true })));
      expect(host.textContent).toBe("1");
      expect(codex).toHaveBeenCalledTimes(1);
    });
  } finally {
    codex.mockRestore();
  }
});

test("only absent turns expire, and profiles keep independent cache entries", async () => {
  const now = spyOn(Date, "now").mockReturnValue(1_000);
  const codex = spyOn(CodexController, "savedThreadsWithTurns").mockResolvedValue(["history"]);
  const targets = [
    ["codex", "workspace", "/repo", "original", "history"],
    ["codex", "workspace", "/repo", "original", "later"],
  ] as const;
  const otherProfile = ["codex", "workspace", "/repo", "other", "later"] as const;
  try {
    expect(await readStoredTurns(targets)).toEqual(new Set([JSON.stringify(targets[0])]));
    now.mockReturnValue(30_999);
    expect(await readStoredTurns(targets)).toEqual(new Set([JSON.stringify(targets[0])]));
    expect(codex).toHaveBeenCalledTimes(1);
    codex.mockResolvedValue(["later"]);
    expect(await readStoredTurns([otherProfile])).toEqual(new Set([JSON.stringify(otherProfile)]));
    now.mockReturnValue(31_000);
    expect(await readStoredTurns(targets)).toEqual(
      new Set(targets.map((target) => JSON.stringify(target))),
    );
    expect(codex).toHaveBeenCalledTimes(3);
    expect(codex.mock.calls[2][1]).toEqual(["later"]);
  } finally {
    now.mockRestore();
    codex.mockRestore();
  }
});
