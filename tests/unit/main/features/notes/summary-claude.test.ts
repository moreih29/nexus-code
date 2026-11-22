import { expect, mock, test } from "bun:test";
import { readdir, stat } from "node:fs/promises";
import { localClaudeSummary } from "../../../../../src/main/features/notes/summary-claude";
import {
  MAX_INPUT_CHARS,
  parseSummaryResult,
  type SummaryRunResult,
  summaryInput,
  summaryLanguage,
} from "../../../../../src/main/features/notes/summary-text";
import type { AgentChannel } from "../../../../../src/main/infra/agent/channel";
import type { TranscriptRecording } from "../../../../../src/shared/notes/transcript";

const output = { summary: ["Three issues remain."], todos: [] };
const result = (value: unknown, fields: Partial<SummaryRunResult> = {}): SummaryRunResult => ({
  code: 0,
  stderr: "",
  stdout: JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: value,
  }),
  ...fields,
});

test("Claude receives only stdin and runs the real executable in a fresh folder with locked-down flags", async () => {
  let root = "";
  const call = mock(async (method: string, params: Record<string, unknown>) => {
    expect(params.cwd ?? params.dir).toBe(root);
    expect(await readdir(root)).toEqual([]);
    if (method === "lsp.findBinary") return { path: "/real/claude", envPath: "/real:/usr/bin" };
    if (params.runId === "run:status") {
      expect(params.stdin).toBe("");
      return result(null, { stdout: '{"loggedIn":true,"authMethod":"apiKey"}' });
    }
    return result(output);
  });
  const dispose = mock(() => {});
  const run = localClaudeSummary({
    openChannel: (dir) => {
      root = dir;
      return { call, dispose } as unknown as AgentChannel;
    },
  });
  const profile = {
    id: "qa",
    agent: "claude" as const,
    dir: "/qa",
    name: "",
    color: "",
    env: {
      PATH: "/wrapper:/real",
      NEXUS_TAB_ID: "tab",
      NEXUS_HOOK_TOKEN: "token",
      NODE_OPTIONS: "--require /unsafe.js",
      ANTHROPIC_API_KEY: "fixture-key",
    },
  };
  const stdin = "private transcript";
  expect(
    await run({
      runId: "run",
      profile,
      language: "ko",
      model: "sonnet",
      stdin,
      signal: new AbortController().signal,
    }),
  ).toEqual({ output });
  expect(call.mock.calls[0]).toEqual([
    "lsp.findBinary",
    {
      name: "claude",
      dir: root,
      searchPath: profile.env.PATH,
      excludeAgentWrappers: true,
    },
  ]);
  const [, req] = call.mock.calls[2];
  expect(req).toMatchObject({ program: "/real/claude", stdin, timeoutMs: 900_000 });
  const args = req.args as string[];
  expect(args.join(" ")).not.toContain(stdin);
  const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
  expect(schema).toMatchObject({ additionalProperties: false, required: ["summary", "todos"] });
  expect(
    args.map((arg) =>
      arg.startsWith('{"type":')
        ? "<schema>"
        : arg.startsWith("You summarize")
          ? "<system prompt>"
          : arg,
    ),
  ).toMatchInlineSnapshot(`
    [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      "<schema>",
      "--tools",
      "",
      "--strict-mcp-config",
      "--settings",
      "{"disableAllHooks":true}",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--setting-sources",
      "",
      "--model",
      "sonnet",
      "--max-budget-usd",
      "2",
      "--system-prompt",
      "<system prompt>",
    ]
  `);
  expect(JSON.stringify(req.env)).not.toMatch(/NEXUS_|\/wrapper|NODE_OPTIONS/);
  expect(req.env).toMatchObject({
    CLAUDE_CONFIG_DIR: "/qa",
    ANTHROPIC_API_KEY: "fixture-key",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    PATH: "/real:/usr/bin",
  });
  expect(call.mock.calls[1][1].env).toEqual(req.env);
  expect(dispose).toHaveBeenCalledTimes(1);
  await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a missing or signed-out Claude never receives the transcript", async () => {
  for (const missing of [false, true]) {
    const call = mock(async (method: string) => {
      if (method === "lsp.findBinary") return { path: missing ? "" : "/real/claude" };
      return result(null, { code: 1, stdout: '{"loggedIn":false}' });
    });
    const run = localClaudeSummary({
      openChannel: () => ({ call, dispose() {} }) as unknown as AgentChannel,
    });
    expect(
      await run({
        runId: "run",
        language: "en",
        stdin: "private transcript",
        signal: new AbortController().signal,
        profile: { id: "qa", agent: "claude", dir: "", name: "", color: "" },
      }),
    ).toMatchObject({ error: { kind: missing ? "missing" : "signed-out" } });
    expect(call).toHaveBeenCalledTimes(missing ? 1 : 2);
  }
});

test("canceling a Claude run sends its run ID to the private local agent", async () => {
  const started = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<SummaryRunResult>();
  const abort = new AbortController();
  const call = mock(async (method: string, params: Record<string, unknown>) => {
    if (method === "lsp.findBinary") return { path: "/real/claude" };
    if (params.runId === "run:status") return result(null, { stdout: '{"loggedIn":true}' });
    if (method === "chat.cancelRun") {
      stopped.resolve(result(null, { code: -1, canceled: true }));
      return true;
    }
    started.resolve();
    return stopped.promise;
  });
  const run = localClaudeSummary({
    openChannel: () => ({ call, dispose() {} }) as unknown as AgentChannel,
  });
  const pending = run({
    runId: "run",
    language: "ko",
    stdin: "private transcript",
    signal: abort.signal,
    profile: { id: "qa", agent: "claude", dir: "", name: "", color: "" },
  });
  await started.promise;
  abort.abort();
  expect(await pending).toMatchObject({ error: { kind: "interrupted" } });
  expect(call.mock.calls[3]).toEqual(["chat.cancelRun", { runId: "run" }, { timeoutMs: 2000 }]);
});

test("reads schema-validated plain text from a Claude result", () => {
  expect(parseSummaryResult(result(output))).toEqual({ output });
  expect(
    parseSummaryResult(
      result({
        summary: [
          "**Agreed** on [the report](https://host/report) and ![the graph](/private/file). <b>Ready</b>.",
        ],
        todos: [{ text: "Review `the report` at https://host/secret", speaker: "S2", atMs: 0 }],
      }),
    ),
  ).toEqual({
    output: {
      summary: ["Agreed on the report and the graph. Ready."],
      todos: [{ text: "Review the report at", speaker: "S2", atMs: 0 }],
    },
  });
  expect(
    parseSummaryResult(
      result(null, {
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: JSON.stringify(output),
        }),
      }),
    ),
  ).toEqual({ output });
  for (const invalid of [
    { ...output, extra: true },
    { summary: ["x".repeat(301)], todos: [] },
    { summary: Array(8).fill("x"), todos: [] },
    { summary: [], todos: [{ text: "Do this" }] },
  ]) {
    expect(parseSummaryResult(result(invalid))).toMatchObject({ error: { kind: "failed" } });
  }
  expect(
    parseSummaryResult(result(null, { stdout: "x".repeat(4 * 1024 * 1024 + 1) })),
  ).toMatchObject({ error: { kind: "failed", message: "Claude exceeded the output limit" } });
});

test("classifies status, usage limits with reset times, timeout and interruption", () => {
  expect(parseSummaryResult(result(null, { code: 1, stderr: "API Error: 401" }))).toMatchObject({
    error: { kind: "signed-out" },
  });
  const error = JSON.stringify({
    type: "result",
    subtype: "error",
    is_error: true,
    result: "429: usage limit, resets 2026-11-22T19:00:00+09:00",
  });
  expect(parseSummaryResult(result(null, { stdout: error }))).toEqual({
    error: { kind: "limit", resetsAt: Date.parse("2026-11-22T19:00:00+09:00") },
  });
  expect(parseSummaryResult(result(null, { timedOut: true }))).toEqual({
    error: { kind: "timeout" },
  });
  expect(parseSummaryResult(result(null, { canceled: true }))).toEqual({
    error: { kind: "interrupted" },
  });
  expect(
    parseSummaryResult(result(null, { code: 1, stderr: `${"a".repeat(4096)}end` })),
  ).toMatchObject({ error: { kind: "failed", message: `${"a".repeat(4093)}end` } });
});

test("stdin uses speaker keys and the user's names and enforces the character limit", () => {
  const recording: TranscriptRecording = {
    id: "r000000abcd",
    startedAt: 0,
    takes: [],
    language: "multi",
    speakers: { "2.1": "한여울" },
    lines: [
      { speaker: "2.1", startMs: 45000, endMs: 49000, text: "정상 수를 확인합니다" },
      { speaker: "1", startMs: 50000, endMs: 55000, text: "확인했습니다" },
    ],
  };
  expect(summaryLanguage(recording, "ko")).toBe("ko");
  expect(summaryInput("Note", recording, "ko")).toContain(
    "Speakers:\n- S1: 한여울\n- S2: 화자 2\nTranscript:\n[0:45 | 45000] S1: 정상 수를 확인합니다",
  );
  expect(
    summaryInput(
      "Note",
      {
        ...recording,
        lines: [{ speaker: "1", startMs: 0, endMs: 30_000, text: "글".repeat(MAX_INPUT_CHARS) }],
      },
      "ko",
    ),
  ).toBeNull();
});
