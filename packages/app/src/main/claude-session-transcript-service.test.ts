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

  test("reads recent entries from an allowed Codex JSONL transcript", async () => {
    const service = new ClaudeSessionTranscriptService({
      now,
      homeDir: () => "/Users/kih",
      readFile: async (filePath) => {
        expect(filePath).toBe("/Users/kih/.codex/sessions/2026/session.jsonl");
        return JSON.stringify({
          event: "user_prompt_submit",
          content: "중국어 추가.",
          timestamp: "2026-04-26T01:00:00.000Z",
        });
      },
    });

    await expect(
      service.readTranscript({
        transcriptPath: "/Users/kih/.codex/sessions/2026/session.jsonl",
      }),
    ).resolves.toMatchObject({
      available: true,
      transcriptPath: "/Users/kih/.codex/sessions/2026/session.jsonl",
      entries: [
        {
          lineNumber: 1,
          role: "event",
          kind: "user_prompt_submit",
          summary: "중국어 추가.",
          timestamp: "2026-04-26T01:00:00.000Z",
        },
      ],
    });
  });

  test("reads OpenCode session messages through the local server API", async () => {
    const fetchCalls: string[] = [];
    const service = new ClaudeSessionTranscriptService({
      now,
      fetchFn: async (input) => {
        fetchCalls.push(String(input));
        return Response.json([
          {
            info: {
              id: "msg_1",
              sessionID: "sess_1",
              role: "user",
              time: { created: 1777194001 },
            },
            parts: [{ type: "text", text: "hello opencode" }],
          },
          {
            info: {
              id: "msg_2",
              sessionID: "sess_1",
              role: "assistant",
              time: { created: 1777194002 },
            },
            parts: [
              { type: "tool", tool: "bash", state: { status: "completed", title: "echo hi" } },
              { type: "text", text: "done" },
            ],
          },
        ]);
      },
    });

    await expect(
      service.readTranscript({
        transcriptPath: "opencode://127.0.0.1:43106/session/sess_1/message",
        limit: 10,
      }),
    ).resolves.toEqual({
      available: true,
      transcriptPath: "opencode://127.0.0.1:43106/session/sess_1/message",
      entries: [
        {
          lineNumber: 1,
          role: "user",
          kind: "opencode-message",
          summary: "hello opencode",
          timestamp: new Date(1777194001 * 1000).toISOString(),
        },
        {
          lineNumber: 2,
          role: "assistant",
          kind: "opencode-message",
          summary: "tool: bash: completed: echo hi done",
          timestamp: new Date(1777194002 * 1000).toISOString(),
        },
      ],
      readAt: "2026-04-26T12:00:00.000Z",
    });
    expect(fetchCalls).toEqual([
      "http://127.0.0.1:43106/session/sess_1/message?limit=10",
    ]);
  });

  test("denies non-local OpenCode transcript URLs", async () => {
    const service = new ClaudeSessionTranscriptService({
      now,
      fetchFn: async () => {
        throw new Error("must not fetch");
      },
    });

    await expect(
      service.readTranscript({
        transcriptPath: "opencode://example.com:43106/session/sess_1/message",
      }),
    ).resolves.toEqual({
      available: false,
      transcriptPath: "opencode://example.com:43106/session/sess_1/message",
      reason: "OpenCode transcript URL must target localhost.",
      readAt: "2026-04-26T12:00:00.000Z",
    });
  });

  test("denies transcript paths outside allowed Claude/Codex roots", async () => {
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
      reason: "Session transcript path is outside allowed Claude/Codex roots.",
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
      reason: "Session transcript path must be a .jsonl file.",
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
