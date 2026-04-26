import { describe, expect, test } from "bun:test";

import {
  ClaudeSessionTranscriptService,
  parseTranscriptJsonl,
} from "./claude-session-transcript-service";

const now = () => new Date("2026-04-26T12:00:00.000Z");

describe("ClaudeSessionTranscriptService", () => {
  test("reads recent entries from an allowed Claude JSONL transcript", async () => {
    const service = new ClaudeSessionTranscriptService({
      now,
      homeDir: () => "/Users/kih",
      readFile: async (filePath) => {
        expect(filePath).toBe("/Users/kih/.claude/projects/proj/session.jsonl");
        return [
          JSON.stringify({
            type: "user",
            message: { role: "user", content: "안녕" },
            timestamp: "2026-04-26T01:00:00.000Z",
          }),
          JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "수정했어요" },
                { type: "tool_use", name: "Edit" },
              ],
            },
          }),
        ].join("\n");
      },
    });

    await expect(
      service.readTranscript({
        transcriptPath: "/Users/kih/.claude/projects/proj/session.jsonl",
        limit: 1,
      }),
    ).resolves.toEqual({
      available: true,
      transcriptPath: "/Users/kih/.claude/projects/proj/session.jsonl",
      entries: [
        {
          lineNumber: 2,
          role: "assistant",
          kind: "assistant",
          summary: "수정했어요 tool_use: Edit",
        },
      ],
      readAt: "2026-04-26T12:00:00.000Z",
    });
  });

  test("denies transcript paths outside ~/.claude/projects", async () => {
    const service = new ClaudeSessionTranscriptService({
      now,
      homeDir: () => "/Users/kih",
      readFile: async () => {
        throw new Error("must not read");
      },
    });

    const result = await service.readTranscript({
      transcriptPath: "/Users/kih/workspaces/project/session.jsonl",
    });

    expect(result).toEqual({
      available: false,
      transcriptPath: "/Users/kih/workspaces/project/session.jsonl",
      reason: "Claude transcript path is outside ~/.claude/projects.",
      readAt: "2026-04-26T12:00:00.000Z",
    });
  });

  test("denies non-jsonl transcript paths", async () => {
    const service = new ClaudeSessionTranscriptService({
      now,
      homeDir: () => "/Users/kih",
    });

    await expect(
      service.readTranscript({
        transcriptPath: "/Users/kih/.claude/projects/proj/session.txt",
      }),
    ).resolves.toMatchObject({
      available: false,
      reason: "Claude transcript path must be a .jsonl file.",
    });
  });

  test("parses invalid JSON lines as readable fallback entries", () => {
    expect(parseTranscriptJsonl("not-json\n{\"event\":\"stop\",\"content\":\"done\"}\n", 10)).toEqual([
      {
        lineNumber: 1,
        role: "unknown",
        kind: "invalid-json",
        summary: "not-json",
      },
      {
        lineNumber: 2,
        role: "event",
        kind: "stop",
        summary: "done",
      },
    ]);
  });
});
