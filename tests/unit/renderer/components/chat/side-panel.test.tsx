import { expect, test } from "bun:test";
import i18next from "i18next";
import { act } from "react";
import { PanelChanged } from "../../../../../src/renderer/components/chat/session-side-panel";
import { SidePanel } from "../../../../../src/renderer/components/chat/side-panel";
import { revealOf } from "../../../../../src/renderer/services/chat/app-commands";
import type { ChatController } from "../../../../../src/renderer/services/chat/claude/controller";
import type { ChatModel } from "../../../../../src/renderer/services/chat/model";
import { type ChatTabState, emptyTabState } from "../../../../../src/renderer/services/chat/store";
import { meterLevel } from "../../../../../src/renderer/services/chat/usage-line";
import { peerWorkspaceId } from "../../../../../src/shared/fs/peer-url";
import { withTestDom } from "../../../../helpers/test-dom";

function fakeController(asked: string[][]): ChatController {
  return {
    key: "ws-1:tab-1",
    profileId: "claude-default",
    usageKey: () => "claude:ws-1",
    supports: () => true,
    refreshPanel: (parts: string[]) => {
      asked.push(parts);
    },
    stopTask: async () => {},
    send: async () => {},
    setRemoteControl: async () => ({ enabled: false }),
  } as unknown as ChatController;
}

function stateOf(ready: boolean, model: Partial<ChatModel> = {}): ChatTabState {
  const empty = emptyTabState();
  return {
    ...empty,
    phase: ready ? "ready" : empty.phase,
    model: { ...empty.model, process: ready ? "running" : "exited", ...model },
  } as ChatTabState;
}

function panel(controller: ChatController, state: ChatTabState) {
  return (
    <SidePanel
      controller={controller}
      state={state}
      workspaceId="ws-1"
      cwd="/repo"
      rootPath="/repo"
      agents={[]}
      onStopRun={() => {}}
      onShowAgent={() => {}}
      onForkSession={() => {}}
    />
  );
}

test("the Claude panel asks for usage and MCP again when the session becomes ready", async () => {
  await withTestDom(async (host, root) => {
    const asked: string[][] = [];
    const controller = fakeController(asked);
    await act(async () => root.render(panel(controller, stateOf(false))));
    const before = asked.length;
    await act(async () => root.render(panel(controller, stateOf(true))));
    const after = asked.slice(before).map((parts) => parts.join(","));
    expect(after).toContain("usage");
    expect(after).toContain("mcp");
    expect(host.textContent).toContain(i18next.t("chat.panel.env.computer"));
    expect(host.textContent).toContain(i18next.t("chat.panel.env.local_computer"));
    expect(host.textContent).toContain(i18next.t("chat.panel.env.profile"));
  });
});

test("the Claude panel opens Changed files for /changes", async () => {
  const style = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: () => ({ overflowY: "visible" }),
  });
  try {
    await withTestDom(async (host, root) => {
      const controller = fakeController([]);
      const state = {
        ...stateOf(true, {
          tools: {
            w: {
              id: "w",
              name: "Write",
              input: { file_path: "/repo/a.ts", content: "x\n" },
              status: "done",
            },
          } as unknown as ChatModel["tools"],
        }),
        reveal: { part: "changes", seq: 1 },
      } as unknown as ChatTabState;
      await act(async () => root.render(panel(controller, state)));
      expect(host.textContent).toContain("a.ts");
    });
  } finally {
    if (style) Object.defineProperty(globalThis, "getComputedStyle", style);
    else Reflect.deleteProperty(globalThis, "getComputedStyle");
  }
});

test("/changes asks the panel for its Changed files section", () => {
  expect(revealOf("/changes")).toBe("changes");
  expect(revealOf("/changes", ["model", "effort"])).toBeNull();
});

test("every usage meter warns at 80% and alerts at 95%", () => {
  expect([79, 80, 94, 95, 100].map(meterLevel)).toEqual([null, "warn", "warn", "alert", "alert"]);
});

test("a remote chat's changed file shows as its agent wrote it, or as its path from an older host", async () => {
  const style = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: () => ({ overflowY: "visible" }),
  });
  const changed = (rawPath?: string) => (
    <PanelChanged
      panel={{
        todos: [],
        tasks: [],
        agents: [],
        changedFiles: [
          { path: "//server/share/x.ts", ...(rawPath ? { rawPath } : {}), added: 1, removed: 0 },
        ],
        context: null,
        goal: null,
      }}
      tools={{}}
      cwd="C:\\p"
      workspaceId={peerWorkspaceId("d1", "w1")}
      reveal={1}
    />
  );
  try {
    await withTestDom(async (host, root) => {
      await act(async () => root.render(changed("\\\\server\\share\\x.ts")));
      expect(host.textContent).toContain("\\\\server\\share\\x.ts");
      expect(host.textContent).not.toContain("//server/share/x.ts");
    });
    await withTestDom(async (host, root) => {
      await act(async () => root.render(changed()));
      expect(host.textContent).toContain("//server/share/x.ts");
    });
  } finally {
    if (style) Object.defineProperty(globalThis, "getComputedStyle", style);
    else Reflect.deleteProperty(globalThis, "getComputedStyle");
  }
});
