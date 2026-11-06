import { describe, expect, test } from "bun:test";
import {
  applyCodexLines,
  type CodexModel,
  emptyCodexModel,
  hunksOf,
  modeOf,
  originalsFor,
  shownCommand,
} from "../../../../../src/renderer/services/chat/codex-model";
import type {
  AssistantItem,
  ChatLine,
  UserItem,
} from "../../../../../src/renderer/services/chat/model";

// Lines as `codex app-server` 0.166.0 writes them (newline-delimited
// JSON-RPC without the "jsonrpc" field), after the generated schema.

let seq = 0;
const out = (message: unknown): ChatLine => ({ seq: ++seq, dir: "out", message, at: 1000 });
const inn = (message: unknown): ChatLine => ({ seq: ++seq, dir: "in", message, at: 1000 });
const sys = (message: unknown): ChatLine => ({ seq: ++seq, dir: "sys", message, at: 1000 });
const note = (method: string, params: unknown) => out({ method, params });

function run(lines: ChatLine[], from: CodexModel = emptyCodexModel()): CodexModel {
  return applyCodexLines(from, lines, 1000);
}

const T = "thr_1";

function started(): ChatLine[] {
  return [
    sys({ event: "start", pid: 1 }),
    inn({ id: "app-1", method: "initialize", params: { clientInfo: { name: "nexus-code" } } }),
    out({ id: "app-1", result: { userAgent: "codex/0.166.0" } }),
    inn({ id: "app-2", method: "thread/start", params: { cwd: "/w" } }),
    out({
      id: "app-2",
      result: {
        thread: { id: T, cliVersion: "0.166.0", name: null, turns: [] },
        model: "gpt-5.5-codex",
        cwd: "/w",
        approvalPolicy: "on-request",
        sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
        reasoningEffort: "medium",
      },
    }),
  ];
}

function sendTurn(text: string, clientId = "c1", turnId = "turn_1"): ChatLine[] {
  return [
    inn({
      id: `app-t-${clientId}`,
      method: "turn/start",
      params: {
        threadId: T,
        clientUserMessageId: clientId,
        input: [{ type: "text", text, text_elements: [] }],
      },
    }),
    out({
      id: `app-t-${clientId}`,
      result: { turn: { id: turnId, items: [], status: "inProgress" } },
    }),
    note("turn/started", { threadId: T, turn: { id: turnId, items: [], status: "inProgress" } }),
    note("item/started", {
      threadId: T,
      turnId,
      item: {
        type: "userMessage",
        id: "item_u1",
        clientId,
        content: [{ type: "text", text, text_elements: [] }],
      },
    }),
  ];
}

describe("codex model", () => {
  test("a started thread tells its settings", () => {
    const m = run(started());
    expect(m.process).toBe("running");
    expect(m.threadId).toBe(T);
    expect(m.model).toBe("gpt-5.5-codex");
    expect(m.effort).toBe("medium");
    expect(m.permissionMode).toBe("auto");
    expect(m.version).toBe("0.166.0");
    expect(Object.keys(m.outgoing)).toEqual([]);
  });

  test("a turn: the message, streamed thinking and answer, a command", () => {
    const m = run([
      ...started(),
      ...sendTurn("list files"),
      note("item/started", {
        threadId: T,
        turnId: "turn_1",
        item: { type: "reasoning", id: "r1", summary: [], content: [] },
      }),
      note("item/reasoning/summaryTextDelta", {
        threadId: T,
        turnId: "turn_1",
        itemId: "r1",
        delta: "Looking",
        summaryIndex: 0,
      }),
      note("item/completed", {
        threadId: T,
        turnId: "turn_1",
        item: { type: "reasoning", id: "r1", summary: ["Looking at files"], content: [] },
      }),
      note("item/started", {
        threadId: T,
        turnId: "turn_1",
        item: {
          type: "commandExecution",
          id: "c1",
          command: "ls",
          cwd: "/w",
          status: "inProgress",
          aggregatedOutput: null,
          exitCode: null,
        },
      }),
      note("item/commandExecution/outputDelta", {
        threadId: T,
        turnId: "turn_1",
        itemId: "c1",
        delta: "a.txt\n",
      }),
      note("item/completed", {
        threadId: T,
        turnId: "turn_1",
        item: {
          type: "commandExecution",
          id: "c1",
          command: "ls",
          cwd: "/w",
          status: "completed",
          aggregatedOutput: "a.txt\nb.txt\n",
          exitCode: 0,
        },
      }),
      note("item/agentMessage/delta", {
        threadId: T,
        turnId: "turn_1",
        itemId: "m1",
        delta: "Two ",
      }),
      note("item/agentMessage/delta", {
        threadId: T,
        turnId: "turn_1",
        itemId: "m1",
        delta: "files",
      }),
    ]);
    expect(m.running).toBe(true);
    expect(m.turnId).toBe("turn_1");
    const user = m.items[0] as UserItem;
    expect(user).toMatchObject({
      kind: "user",
      text: "list files",
      state: "taken",
      uuid: "item_u1",
    });
    const answer = m.items[1] as AssistantItem;
    expect(answer.blocks).toEqual([
      { type: "thinking", text: "Looking at files" },
      { type: "tool", toolUseId: "c1" },
      { type: "text", text: "Two files" },
    ]);
    expect(m.tools.c1).toMatchObject({
      name: "Bash",
      input: { command: "ls" },
      status: "done",
      result: { text: "a.txt\nb.txt\n", structured: { stdout: "a.txt\nb.txt\n" } },
    });

    const done = run(
      [
        note("item/completed", {
          threadId: T,
          turnId: "turn_1",
          item: { type: "agentMessage", id: "m1", text: "Two files." },
        }),
        note("turn/completed", {
          threadId: T,
          turn: { id: "turn_1", items: [], status: "completed", durationMs: 900 },
        }),
      ],
      m,
    );
    expect(done.running).toBe(false);
    expect(done.turnId).toBeUndefined();
    expect((done.items[1] as AssistantItem).blocks[2]).toEqual({
      type: "text",
      text: "Two files.",
    });
    expect(done.lastResult).toMatchObject({
      subtype: "completed",
      isError: false,
      durationMs: 900,
    });
  });

  test("an item id used again in a later turn is that turn's", () => {
    const answer = (turnId: string, text: string) => [
      note("item/agentMessage/delta", { threadId: T, turnId, itemId: "m1", delta: text }),
      note("item/completed", {
        threadId: T,
        turnId,
        item: { type: "agentMessage", id: "m1", text, phase: null },
      }),
      note("turn/completed", {
        threadId: T,
        turn: { id: turnId, items: [], status: "completed", error: null },
      }),
    ];
    const m = run([
      ...started(),
      ...sendTurn("one", "c1", "turn_1"),
      ...answer("turn_1", "first"),
      ...sendTurn("two", "c2", "turn_2"),
      ...answer("turn_2", "second"),
    ]);
    const texts = m.items
      .filter((i): i is AssistantItem => i.kind === "assistant")
      .map((i) => i.blocks.map((b) => (b.type === "tool" ? "" : b.text)).join(""));
    expect(texts).toEqual(["first", "second"]);
  });

  test("a message the app sent shows at once, then as taken", () => {
    const begin = started();
    const [request] = sendTurn("hi", "c9");
    const sent = run([...begin, request]);
    expect(sent.items[0]).toMatchObject({ kind: "user", key: "u-c9", text: "hi", state: "sent" });
    expect(sent.running).toBe(true);
    const echoed = run(sendTurn("hi", "c9").slice(1), sent);
    expect(echoed.items).toHaveLength(1);
    expect(echoed.items[0]).toMatchObject({ state: "taken", uuid: "item_u1" });
  });

  test("a command's approval is a permission, and declining it denies the call", () => {
    const command = {
      type: "commandExecution",
      id: "c2",
      command: "rm x",
      cwd: "/w",
      status: "inProgress",
      aggregatedOutput: null,
      exitCode: null,
    };
    const asked = run([
      ...started(),
      ...sendTurn("remove x"),
      note("item/started", { threadId: T, turnId: "turn_1", item: command }),
      out({
        id: 0,
        method: "item/commandExecution/requestApproval",
        params: { threadId: T, turnId: "turn_1", itemId: "c2", command: "rm x", reason: "deletes" },
      }),
    ]);
    expect(asked.permissions).toEqual([
      expect.objectContaining({
        requestId: "0",
        toolName: "Bash",
        input: { command: "rm x", cwd: "/w" },
        description: "deletes",
        toolUseId: "c2",
      }),
    ]);
    const declined = run([inn({ id: 0, result: { decision: "decline" } })], asked);
    expect(declined.permissions).toEqual([]);
    expect(declined.requests).toEqual({});
    expect(declined.tools.c2.status).toBe("denied");
    const after = run(
      [
        note("item/completed", {
          threadId: T,
          turnId: "turn_1",
          item: { ...command, status: "declined" },
        }),
      ],
      declined,
    );
    expect(after.tools.c2.status).toBe("denied");
  });

  test("a patch: a row for each file, and an approval that previews them", () => {
    const item = {
      type: "fileChange",
      id: "p1",
      status: "inProgress",
      changes: [
        { path: "/w/new.txt", kind: { type: "add" }, diff: "hello\n" },
        {
          path: "/w/a.txt",
          kind: { type: "update", move_path: null },
          diff: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
        },
      ],
    };
    const m = run([
      ...started(),
      ...sendTurn("edit"),
      note("item/started", { threadId: T, turnId: "turn_1", item }),
      out({
        id: 1,
        method: "item/fileChange/requestApproval",
        params: { threadId: T, turnId: "turn_1", itemId: "p1", reason: null },
      }),
    ]);
    expect((m.items[1] as AssistantItem).blocks).toEqual([
      { type: "tool", toolUseId: "p1:0" },
      { type: "tool", toolUseId: "p1:1" },
    ]);
    expect(m.tools["p1:0"]).toMatchObject({
      name: "Write",
      input: { file_path: "/w/new.txt" },
      result: { structured: { type: "create", structuredPatch: [{ lines: ["+hello"] }] } },
    });
    expect(m.tools["p1:1"]).toMatchObject({
      name: "Edit",
      result: { structured: { structuredPatch: [{ lines: ["-old", "+new"] }] } },
    });
    const [permission] = m.permissions;
    expect(permission).toMatchObject({
      toolName: "Edit",
      input: { file_path: "/w/new.txt, /w/a.txt" },
    });
    expect(permission.preview?.result?.structured).toEqual({
      structuredPatch: [
        { lines: ["/w/new.txt", "+hello"] },
        { lines: ["/w/a.txt", "-old", "+new"] },
      ],
    });
  });

  test("a question from the model shows as AskUserQuestion", () => {
    const m = run([
      ...started(),
      ...sendTurn("ask me"),
      out({
        id: 2,
        method: "item/tool/requestUserInput",
        params: {
          threadId: T,
          turnId: "turn_1",
          itemId: "q1",
          questions: [
            {
              id: "color",
              header: "Color",
              question: "Which color?",
              isOther: true,
              isSecret: false,
              options: [{ label: "Red", description: "warm" }],
            },
          ],
        },
      }),
    ]);
    expect(m.permissions[0]).toMatchObject({
      toolName: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "Which color?",
            header: "Color",
            multiSelect: false,
            options: [{ label: "Red", description: "warm" }],
          },
        ],
      },
    });
    // The server withdraws a question the turn no longer needs.
    const resolved = run([note("serverRequest/resolved", { threadId: T, requestId: 2 })], m);
    expect(resolved.permissions).toEqual([]);
  });

  test("an interrupted turn stops its calls; a failed one tells its error once", () => {
    const base = run([
      ...started(),
      ...sendTurn("sleep"),
      note("item/started", {
        threadId: T,
        turnId: "turn_1",
        item: { type: "commandExecution", id: "c3", command: "sleep 9", status: "inProgress" },
      }),
      inn({ id: "app-i", method: "turn/interrupt", params: { threadId: T, turnId: "turn_1" } }),
    ]);
    expect(base.interrupting).toBe(true);
    const stopped = run(
      [
        note("turn/completed", {
          threadId: T,
          turn: { id: "turn_1", items: [], status: "interrupted" },
        }),
      ],
      base,
    );
    expect(stopped.tools.c3.status).toBe("stopped");
    expect(stopped.items.at(-1)).toMatchObject({ kind: "notice", code: "interrupted" });
    expect(stopped.interrupting).toBe(false);

    const failed = run([
      ...started(),
      ...sendTurn("go"),
      note("error", {
        threadId: T,
        turnId: "turn_1",
        error: { message: "quota" },
        willRetry: false,
      }),
      note("turn/completed", {
        threadId: T,
        turn: { id: "turn_1", items: [], status: "failed", error: { message: "quota" } },
      }),
    ]);
    expect(failed.items.filter((i) => i.kind === "notice")).toEqual([
      expect.objectContaining({ code: "error", detail: "quota" }),
    ]);
  });

  test("a retried error shows on the turn, not as a notice", () => {
    const m = run([
      ...started(),
      ...sendTurn("go"),
      note("error", { threadId: T, turnId: "turn_1", error: { message: "busy" }, willRetry: true }),
    ]);
    expect(m.turn?.retry).toEqual({ attempt: 1 });
    expect(m.items.some((i) => i.kind === "notice")).toBe(false);
  });

  test("a resumed thread shows its turns", () => {
    const m = run([
      sys({ event: "start", pid: 1 }),
      inn({ id: "app-r", method: "thread/resume", params: { threadId: T } }),
      out({
        id: "app-r",
        result: {
          thread: {
            id: T,
            turns: [
              {
                id: "turn_0",
                status: "completed",
                items: [
                  {
                    type: "userMessage",
                    id: "u0",
                    clientId: null,
                    content: [{ type: "text", text: "earlier" }],
                  },
                  { type: "agentMessage", id: "m0", text: "answer" },
                ],
              },
            ],
          },
          model: "gpt-5.5-codex",
          sandbox: { type: "readOnly" },
        },
      }),
    ]);
    expect(m.permissionMode).toBe("readOnly");
    expect(m.items).toEqual([
      expect.objectContaining({ kind: "user", text: "earlier", uuid: "u0", state: "taken" }),
      expect.objectContaining({ kind: "assistant", blocks: [{ type: "text", text: "answer" }] }),
    ]);
  });

  test("another thread's items are not the tab's", () => {
    const m = run([
      ...started(),
      ...sendTurn("go"),
      note("item/completed", {
        threadId: "thr_sub",
        turnId: "turn_x",
        item: { type: "agentMessage", id: "mx", text: "sub" },
      }),
    ]);
    expect(m.items).toHaveLength(1);
  });

  test("the program's exit ends its requests and turn", () => {
    const m = run([
      ...started(),
      ...sendTurn("go"),
      out({
        id: 3,
        method: "item/commandExecution/requestApproval",
        params: { threadId: T, turnId: "turn_1", itemId: "c9", command: "x" },
      }),
      sys({ event: "exit", code: 0 }),
    ]);
    expect(m.process).toBe("exited");
    expect(m.running).toBe(false);
    expect(m.permissions).toEqual([]);
    expect(m.requests).toEqual({});
    expect(m.threadId).toBe(T);
  });

  test("the files' originals the agent took are kept, whatever comes after", () => {
    const m = run([
      ...started(),
      sys({ event: "snapshot", path: "/w/a.ts", before: "old\r\n" }),
      sys({ event: "snapshot", path: "/w/new.ts", before: null }),
      sys({ event: "snapshot", path: "/w/odd.ts", before: 3 }),
      sys({ event: "exit", code: 0 }),
    ]);
    expect(m.originals).toEqual({ "/w/a.ts": "old\r\n", "/w/new.ts": null });
    expect(m.items.filter((item) => item.kind === "notice")).toHaveLength(1);
  });

  test("the models, the account and errors of the app's own requests", () => {
    const m = run([
      ...started(),
      inn({ id: "app-m", method: "model/list", params: {} }),
      out({
        id: "app-m",
        result: {
          data: [
            {
              id: "gpt-5.5-codex",
              model: "gpt-5.5-codex",
              displayName: "GPT-5.5 Codex",
              description: "Coding",
              hidden: false,
              supportedReasoningEfforts: [
                { reasoningEffort: "low", description: "" },
                { reasoningEffort: "high", description: "" },
              ],
            },
            { id: "old", model: "old", hidden: true },
          ],
        },
      }),
      inn({ id: "app-a", method: "account/read", params: {} }),
      out({
        id: "app-a",
        result: { account: { type: "chatgpt", email: "x@y.z" }, requiresOpenaiAuth: true },
      }),
      inn({ id: "app-f", method: "fuzzyFileSearch", params: { query: "a" } }),
      out({ id: "app-f", error: { code: -1, message: "no" } }),
    ]);
    expect(m.init?.models).toEqual([
      {
        value: "gpt-5.5-codex",
        displayName: "GPT-5.5 Codex",
        description: "Coding",
        supportedEffortLevels: ["low", "high"],
      },
    ]);
    // The account's kind only: never who it is.
    expect(m.account).toEqual({ type: "chatgpt" });
    expect(m.signedOut).toBe(false);
    expect(m.items).toEqual([]);
  });

  test("a program not signed in says so", () => {
    const m = run([
      ...started(),
      inn({ id: "app-a", method: "account/read", params: {} }),
      out({ id: "app-a", result: { account: null, requiresOpenaiAuth: true } }),
    ]);
    expect(m.account).toBeNull();
    expect(m.signedOut).toBe(true);
    const signedIn = run([note("account/updated", { authMode: "chatgpt", planType: "plus" })], m);
    expect(signedIn.signedOut).toBe(false);
    expect(signedIn.account).toEqual({ type: "chatgpt" });
  });

  test("a turn that could not start ends the wait and says why", () => {
    const begin = started();
    const [request] = sendTurn("go");
    const m = run([
      ...begin,
      request,
      out({ id: "app-t-c1", error: { message: "not signed in" } }),
    ]);
    expect(m.running).toBe(false);
    expect(m.items.at(-1)).toMatchObject({
      kind: "notice",
      code: "error",
      detail: "not signed in",
    });
  });
});

describe("codex helpers", () => {
  test("modeOf reads policies and modes", () => {
    expect(modeOf({ type: "dangerFullAccess" })).toBe("fullAccess");
    expect(modeOf("read-only")).toBe("readOnly");
    expect(modeOf("workspace-write")).toBe("auto");
    expect(modeOf({ type: "externalSandbox" })).toBeUndefined();
  });

  test("shownCommand drops the shell Codex runs a command in", () => {
    expect(shownCommand("/bin/bash -lc 'printf hi > note.txt && cat note.txt'")).toBe(
      "printf hi > note.txt && cat note.txt",
    );
    expect(shownCommand(`/bin/zsh -lc 'echo '"'"'quoted'"'"''`)).toBe("echo 'quoted'");
    expect(shownCommand("bash -c ls")).toBe("ls");
    expect(shownCommand('bash -lc "echo \\"a\\""')).toBe('echo "a"');
    // Not one script: shown as it is.
    expect(shownCommand("bash -lc 'a' 'b'")).toBe("bash -lc 'a' 'b'");
    expect(shownCommand('bash -lc "echo $HOME"')).toBe('bash -lc "echo $HOME"');
    expect(shownCommand("ls -la")).toBe("ls -la");
  });

  test("originalsFor finds a list's files, a Windows path whichever way it is written", () => {
    const originals = { "C:\\w\\src\\a.ts": "a", "/srv/b.ts": null, "/srv/c.ts": "c" };
    expect(
      originalsFor(originals, ["c:/w/src/a.ts", "/srv/b.ts", "/srv/C.ts", "/srv/d.ts"]),
    ).toEqual({
      "c:/w/src/a.ts": "a",
      "/srv/b.ts": null,
    });
  });

  test("hunksOf reads unified diffs and whole files", () => {
    expect(hunksOf("@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -9 +9 @@\n-x\n", "update")).toEqual([
      { lines: [" a", "-b", "+c"] },
      { lines: ["-x"] },
    ]);
    expect(hunksOf("@@ -1 +1 @@\n-hi\n\\ No newline at end of file\n+hello\n", "update")).toEqual([
      { lines: ["-hi", "+hello"] },
    ]);
    expect(hunksOf("gone\n", "delete")).toEqual([{ lines: ["-gone"] }]);
    expect(hunksOf("", "add")).toEqual([]);
  });
});
