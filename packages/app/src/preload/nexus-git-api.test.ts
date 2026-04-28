import { describe, expect, test } from "bun:test";

import {
  GIT_BRIDGE_EVENT_CHANNEL,
  GIT_BRIDGE_INVOKE_CHANNEL,
} from "../../../shared/src/contracts/ipc-channels";
import type { GitBridgeEvent, GitBridgeRequest, GitBridgeResult } from "../main/git/git-bridge-ipc";
import { createNexusGitApi } from "./nexus-git-api";

describe("createNexusGitApi", () => {
  test("invokes and subscribes git bridge IPC", async () => {
    const ipcRenderer = new FakeIpcRenderer();
    const api = createNexusGitApi(ipcRenderer);
    const request: GitBridgeRequest = {
      type: "git/lifecycle",
      action: "status",
      requestId: "git-1",
      workspaceId: "ws_alpha",
      cwd: "/tmp/alpha",
    };
    const observed: GitBridgeEvent[] = [];

    await api.invoke(request);
    const subscription = api.onEvent((event) => observed.push(event));
    ipcRenderer.emitGitEvent(ipcRenderer.reply);
    subscription.dispose();

    expect(ipcRenderer.invokeCalls).toEqual([{ channel: GIT_BRIDGE_INVOKE_CHANNEL, payload: request }]);
    expect(observed).toEqual([ipcRenderer.reply]);
    expect(ipcRenderer.removedChannels).toEqual([GIT_BRIDGE_EVENT_CHANNEL]);
  });
});

class FakeIpcRenderer {
  public readonly invokeCalls: Array<{ channel: string; payload: unknown }> = [];
  public readonly removedChannels: string[] = [];
  public readonly reply: GitBridgeResult = {
    type: "git/lifecycle",
    action: "status_result",
    requestId: "git-1",
    workspaceId: "ws_alpha",
    cwd: "/tmp/alpha",
    summary: {
      branch: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [],
    },
    generatedAt: "2026-04-28T00:00:00.000Z",
  };
  private listener: ((event: unknown, payload: GitBridgeEvent) => void) | null = null;

  public invoke(channel: string, payload?: unknown): Promise<GitBridgeResult> {
    this.invokeCalls.push({ channel, payload });
    return Promise.resolve(this.reply);
  }

  public on(channel: string, listener: (event: unknown, payload: GitBridgeEvent) => void): void {
    if (channel === GIT_BRIDGE_EVENT_CHANNEL) {
      this.listener = listener;
    }
  }

  public removeListener(channel: string, listener: (event: unknown, payload: GitBridgeEvent) => void): void {
    if (this.listener === listener) {
      this.listener = null;
    }
    this.removedChannels.push(channel);
  }

  public emitGitEvent(event: GitBridgeEvent): void {
    this.listener?.({}, event);
  }
}
