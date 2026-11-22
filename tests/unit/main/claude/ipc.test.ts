import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { ActiveContextStore } from "../../../../src/main/features/claude/active-context";
import { ChatAnswers } from "../../../../src/main/features/claude/chat-answers";
import { registerClaudeChannel } from "../../../../src/main/features/claude/ipc";
import { PermissionAsks } from "../../../../src/main/features/claude/permission-asks";
import { SessionActivityLog } from "../../../../src/main/features/claude/session-activity";
import { ClaudeStatusBroker } from "../../../../src/main/features/claude/status";
import { createIpcPair, resetInMemoryIpc, setupInMemoryRouter } from "../../../helpers/ipc-pair";

beforeEach(resetInMemoryIpc);
afterEach(() => {
  setSystemTime();
  resetInMemoryIpc();
});

test.each([
  ["completed", { completedAt: 300, resultAt: 250 }, "idle"],
  ["completed", { completedAt: 299 }, "completed"],
  ["completed", { completedAt: 300, resultAt: 199 }, "completed"],
  ["needsInput", { completedAt: 300 }, "needsInput"],
  ["needsInput", {}, "idle"],
] as const)("marks %s with %j as %s", async (status, receipt, expected) => {
  await setupInMemoryRouter();
  const broker = new ClaudeStatusBroker(() => {});
  registerClaudeChannel(
    broker,
    new ActiveContextStore(),
    new SessionActivityLog(),
    new PermissionAsks(async () => {}),
    new ChatAnswers(),
    async () => false,
  );
  const { window } = createIpcPair();
  const workspaceId = "w";
  const tabId = "t";
  setSystemTime(new Date(200));
  broker.set(workspaceId, tabId, "running");
  setSystemTime(new Date(300));
  broker.set(workspaceId, tabId, status);
  expect(
    await window.ipc.call("claude", "markSeen", { workspaceId, tabId, ...receipt }),
  ).toMatchObject({ ok: true });
  expect(broker.get(workspaceId, tabId)?.status).toBe(expected);
});
