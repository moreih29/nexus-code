import { expect, test } from "bun:test";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { runCli } from "../../../../src/main/features/cli/registry";
import type { CliAgentView, CliViewHeldTab } from "../../../../src/shared/cli/ui";
import { remoteFileKey } from "../../../../src/shared/fs/remote-file-key";
import { APP, CLAUDE_TAB, contextFor, EDITOR_TAB, fakeApp } from "./fake-services";

const agent = {
  key: `${APP}:${CLAUDE_TAB}`,
  workspaceId: APP,
  tabId: CLAUDE_TAB,
  title: "✳ Claude Code",
  type: "terminal",
};
const peer = { deviceId: "8abe5e46-desk", workspaceId: "peer-workspace" };
const remoteFile = (path: string, title: string): CliViewHeldTab => ({
  key: remoteFileKey({ ...peer, path }),
  kind: "remote-file",
  workspaceId: peer.workspaceId,
  title,
  device: "Fake Desk",
  path,
});
const held = [
  {
    key: `${APP}:${EDITOR_TAB}`,
    kind: "file",
    workspaceId: APP,
    title: "index.ts",
    path: "/w/app/index.ts",
  },
  remoteFile("/peer/refresh.pdf", "refresh.pdf"),
  remoteFile("/peer/notes.md", "notes.md"),
  {
    key: `remote:${peer.deviceId}/${peer.workspaceId}/318d5da9`,
    kind: "remote-session",
    workspaceId: peer.workspaceId,
    title: "세션 제목",
    device: "Fake Desk",
    path: "/peer",
  },
] satisfies CliViewHeldTab[];
const root = {
  kind: "group" as const,
  id: "p1",
  tabIds: [agent.key, ...held.map((tab) => tab.key), `${APP}:missing-tab`],
  shownTabId: remoteFile("/peer/refresh.pdf", "refresh.pdf").key,
};

function mixedView() {
  const app = fakeApp();
  app.uiAnswers.set("agentView.get", {
    view: "agents",
    grouping: "status",
    root,
    activePanelId: root.id,
    agents: [agent],
    held,
  } satisfies CliAgentView);
  return app;
}

test("view layout names every tab in panel order and marks the one shown", async () => {
  const app = mixedView();
  const { stdout, exitCode } = await runCli(CLI_COMMANDS, contextFor(app, ["view", "layout"]));
  expect(exitCode).toBe(0);
  expect(stdout).toBe(
    "shown: the agent view\n" +
      "panel 1 (p1), active: ✳ Claude Code [app], index.ts [app], *refresh.pdf [Fake Desk], " +
      "notes.md [Fake Desk], 세션 제목 [Fake Desk], missing-\n",
  );
});

test("view layout --json adds held tab details alongside existing session fields", async () => {
  const app = mixedView();
  const { stdout, exitCode } = await runCli(
    CLI_COMMANDS,
    contextFor(app, ["view", "layout", "--json"]),
  );
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toEqual({
    view: "agents",
    activePanelId: "p1",
    root,
    panels: [
      {
        number: 1,
        id: "p1",
        sessions: [
          { workspaceId: APP, tabId: CLAUDE_TAB, title: agent.title },
          ...held,
          { key: `${APP}:missing-tab` },
        ],
        shownTabId: root.shownTabId.split(":")[1],
      },
    ],
  });
});

test("status reads mixed panels and view focus still selects panels by local session", async () => {
  const app = mixedView();
  const status = await runCli(CLI_COMMANDS, contextFor(app, ["status"]));
  expect(status.exitCode).toBe(0);
  expect(status.stdout).toContain("view:      the agent view, 1 panel\n");

  const local = await runCli(CLI_COMMANDS, contextFor(app, ["view", "focus", agent.title]));
  const remote = await runCli(CLI_COMMANDS, contextFor(app, ["view", "focus", "세션 제목"]));
  expect(local.exitCode).toBe(0);
  expect(remote.exitCode).not.toBe(0);
  expect(app.uiCalls.filter((call) => call.op === "agentView.focus")).toEqual([
    { op: "agentView.focus", args: { panelId: "p1" } },
  ]);
});
