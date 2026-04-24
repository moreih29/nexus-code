import { describe, expect, test } from "bun:test";

import {
  TERMINAL_EVENT_CHANNEL,
  TERMINAL_INVOKE_CHANNEL,
} from "../../../../shared/src/contracts/ipc-channels";
import {
  ElectronTerminalIpcAdapter,
  type ElectronTerminalIpcAdapterOptions,
} from "./electron-terminal-ipc-adapter";

describe("ElectronTerminalIpcAdapter", () => {
  test("registers terminal:invoke and routes command payloads", async () => {
    const ipcMain = new FakeIpcMain();
    const webContents = new FakeWebContents();
    const adapter = createAdapter({ ipcMain, webContents });

    const subscription = adapter.onCommand(async (payload) => {
      return {
        seenPayload: payload,
      };
    });

    expect(ipcMain.lastHandleChannel).toBe(TERMINAL_INVOKE_CHANNEL);

    await expect(
      ipcMain.invoke({
        type: "terminal/open",
        workspaceId: "ws_alpha",
      }),
    ).resolves.toEqual({
      seenPayload: {
        type: "terminal/open",
        workspaceId: "ws_alpha",
      },
    });

    subscription.dispose();

    expect(ipcMain.removedChannels).toEqual([TERMINAL_INVOKE_CHANNEL]);
    await expect(ipcMain.invoke({ type: "terminal/open" })).rejects.toThrow(
      "No invoke handler is registered.",
    );
  });

  test("forwards terminal:event payloads to renderer webContents", () => {
    const webContents = new FakeWebContents();
    const adapter = createAdapter({
      ipcMain: new FakeIpcMain(),
      webContents,
    });

    const payload = {
      type: "terminal/stdout",
      tabId: "tt_ws_alpha_0001",
      seq: 1,
      data: "echo hi\\n",
    };

    adapter.sendEvent(payload);

    expect(webContents.sendCalls).toEqual([
      {
        channel: TERMINAL_EVENT_CHANNEL,
        payload,
      },
    ]);
  });

  test("does not send terminal:event after renderer webContents is destroyed", () => {
    const webContents = new FakeWebContents();
    webContents.destroyed = true;

    const adapter = createAdapter({
      ipcMain: new FakeIpcMain(),
      webContents,
    });

    adapter.sendEvent({ type: "terminal/exited" });

    expect(webContents.sendCalls).toHaveLength(0);
  });
});

function createAdapter({
  ipcMain,
  webContents,
}: {
  ipcMain: FakeIpcMain;
  webContents: FakeWebContents;
}): ElectronTerminalIpcAdapter {
  const options: ElectronTerminalIpcAdapterOptions = {
    ipcMain: ipcMain as unknown as ElectronTerminalIpcAdapterOptions["ipcMain"],
    resolveEventSink: () => webContents,
  };

  return new ElectronTerminalIpcAdapter(options);
}

class FakeIpcMain {
  public lastHandleChannel: string | null = null;
  public removedChannels: string[] = [];

  private invokeHandler:
    | ((event: unknown, payload: unknown) => Promise<unknown> | unknown)
    | null = null;

  public handle(
    channel: string,
    listener: (event: unknown, payload: unknown) => Promise<unknown> | unknown,
  ): void {
    this.lastHandleChannel = channel;
    this.invokeHandler = listener;
  }

  public removeHandler(channel: string): void {
    this.removedChannels.push(channel);
    this.invokeHandler = null;
  }

  public async invoke(payload: unknown): Promise<unknown> {
    if (!this.invokeHandler) {
      throw new Error("No invoke handler is registered.");
    }

    return this.invokeHandler({}, payload);
  }
}

class FakeWebContents {
  public destroyed = false;
  public readonly sendCalls: Array<{ channel: string; payload: unknown }> = [];

  public send(channel: string, payload: unknown): void {
    this.sendCalls.push({ channel, payload });
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }
}
