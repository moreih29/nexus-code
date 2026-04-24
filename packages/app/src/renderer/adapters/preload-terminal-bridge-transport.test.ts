import { afterEach, describe, expect, test } from "bun:test";

import { PreloadTerminalBridgeTransport } from "./preload-terminal-bridge-transport";

type NexusTerminalLike = Window["nexusTerminal"];

const globalWithWindow = globalThis as typeof globalThis & {
  window?: {
    nexusTerminal: NexusTerminalLike;
  };
};

let originalWindow = globalWithWindow.window;

afterEach(() => {
  if (originalWindow === undefined) {
    delete globalWithWindow.window;
    return;
  }

  globalWithWindow.window = originalWindow;
});

describe("PreloadTerminalBridgeTransport", () => {
  test("delegates invoke + event subscription through window.nexusTerminal", async () => {
    const invokeCalls: unknown[] = [];
    const eventListeners = new Set<(payload: unknown) => void>();

    globalWithWindow.window = {
      nexusTerminal: {
        invoke: async (command) => {
          invokeCalls.push(command);
          return {
            ok: true,
          };
        },
        onEvent: (listener) => {
          eventListeners.add(listener as (payload: unknown) => void);
          return {
            dispose: () => {
              eventListeners.delete(listener as (payload: unknown) => void);
            },
          };
        },
      },
    };

    const transport = new PreloadTerminalBridgeTransport();

    await expect(
      transport.invoke({
        type: "terminal/open",
      }),
    ).resolves.toEqual({
      ok: true,
    });
    expect(invokeCalls).toEqual([
      {
        type: "terminal/open",
      },
    ]);

    const receivedPayloads: unknown[] = [];
    const subscription = transport.onEvent((payload) => {
      receivedPayloads.push(payload);
    });

    const emittedPayload = {
      type: "terminal/stdout",
      tabId: "tt_ws_alpha_0001",
      seq: 0,
      data: "hello",
    };
    for (const listener of eventListeners) {
      listener(emittedPayload);
    }

    expect(receivedPayloads).toEqual([emittedPayload]);

    subscription.dispose();
    expect(eventListeners).toHaveLength(0);
  });
});
