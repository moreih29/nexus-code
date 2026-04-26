import { describe, expect, test } from "bun:test";

import { CLAUDE_SESSION_READ_TRANSCRIPT_CHANNEL } from "../../../shared/src/contracts/ipc-channels";
import { createNexusClaudeSessionApi } from "./nexus-claude-session-api";

describe("createNexusClaudeSessionApi", () => {
  test("invokes Claude transcript read channel", async () => {
    const ipcRenderer = new FakeIpcRenderer();
    const api = createNexusClaudeSessionApi(ipcRenderer);

    await expect(
      api.readTranscript({ transcriptPath: "/Users/kih/.claude/projects/p/s.jsonl" }),
    ).resolves.toEqual({ available: true });

    expect(ipcRenderer.invokeCalls).toEqual([
      {
        channel: CLAUDE_SESSION_READ_TRANSCRIPT_CHANNEL,
        payload: { transcriptPath: "/Users/kih/.claude/projects/p/s.jsonl" },
      },
    ]);
  });
});

class FakeIpcRenderer {
  public readonly invokeCalls: Array<{ channel: string; payload: unknown }> = [];

  public invoke(channel: string, payload?: unknown): Promise<unknown> {
    this.invokeCalls.push({ channel, payload });
    return Promise.resolve({ available: true });
  }
}
