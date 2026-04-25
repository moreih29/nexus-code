import { describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../contracts/workspace";
import type { AdapterMetadata, HarnessAdapter, ObserverEvent } from "./HarnessAdapter";

class MockHarnessAdapter implements HarnessAdapter {
  describe(): AdapterMetadata {
    return {
      name: "mock",
      version: "0.0.0-test",
      observationPath: "mixed",
    };
  }

  async *observe(_workspaceId: WorkspaceId): AsyncIterable<ObserverEvent> {}

  dispose(): void {}
}

describe("HarnessAdapter contract", () => {
  test("mock adapter satisfies describe, observe, and dispose contract", async () => {
    const adapter = new MockHarnessAdapter();

    expect(adapter.describe()).toEqual({
      name: "mock",
      version: "0.0.0-test",
      observationPath: "mixed",
    });

    const events = adapter.observe("ws_mock");
    expect(typeof events[Symbol.asyncIterator]).toBe("function");

    const emitted: ObserverEvent[] = [];
    for await (const event of events) {
      emitted.push(event);
    }

    expect(emitted).toEqual([]);
    await adapter.dispose();
  });
});
