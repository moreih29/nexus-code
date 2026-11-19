import { expect, jest, test } from "bun:test";
import { RendererBridge } from "../../../../src/main/features/cli/renderer-bridge";

test("a destroyed renderer rejects the CLI request and cancels its reply timer", async () => {
  jest.useFakeTimers();
  const gone = new Error("webContents was destroyed");
  let requestId: string | undefined;
  const bridge = new RendererBridge(() => ({
    webContents: {
      send: (_channel, _group, _event, request) => {
        requestId = (request as { requestId: string }).requestId;
        throw gone;
      },
      focus: () => {},
    },
  }));
  try {
    await expect(bridge.ask("tabs.list", { workspaceId: "test" })).rejects.toBe(gone);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    // Release a leaked request on the broken implementation without rejecting its orphan promise.
    if (requestId) bridge.resolve({ requestId, ok: true, value: { tabs: [] } });
    jest.useRealTimers();
  }
});
