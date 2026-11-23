import { describe, expect, test } from "bun:test";
import { transcriptLines } from "../../../../../src/renderer/services/chat/claude/history";
import {
  applyLines,
  applyTranscriptLines,
} from "../../../../../src/renderer/services/chat/claude/stream-model";
import {
  applyCodexLines,
  emptyCodexModel,
} from "../../../../../src/renderer/services/chat/codex/model";
import { type ChatLine, emptyModel } from "../../../../../src/renderer/services/chat/model";

const user: ChatLine = {
  seq: 1,
  at: 1_000,
  dir: "in",
  message: { type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
};

function claudeFailure(fields: Record<string, unknown>, text: string): ChatLine[] {
  return [
    user,
    {
      seq: 2,
      at: 2_000,
      dir: "out",
      message: {
        type: "assistant",
        message: { id: "m1", model: "<synthetic>", content: [{ type: "text", text }] },
        parent_tool_use_id: null,
        error: "rate_limit",
        is_api_error_message: true,
        ...fields,
      },
    },
    {
      seq: 3,
      at: 2_100,
      dir: "out",
      message: {
        type: "result",
        subtype: "success",
        is_error: true,
        terminal_reason: "api_error",
        result: text,
        ...fields,
      },
    },
  ];
}

describe("a Claude turn that failed on the API", () => {
  test("shows one error notice, not Claude's words, and says what failed", () => {
    const text = "API Error: 529 Overloaded. This is a server-side issue";
    const model = applyLines(
      emptyModel(),
      claudeFailure({ api_error_status: 529, api_error_type: "overloaded_error" }, text),
    );
    expect(model.items.map((item) => item.kind)).toEqual(["user", "notice"]);
    expect(model.items.at(-1)).toEqual(
      expect.objectContaining({ kind: "notice", code: "error", detail: text }),
    );
    expect(model.lastResult?.failure).toEqual({ kind: "transient", status: 529 });
  });

  test("tells a refused key, a refused request and a lost connection apart", () => {
    const failureOf = (fields: Record<string, unknown>) =>
      applyLines(emptyModel(), claudeFailure(fields, "API Error")).lastResult?.failure;
    expect(failureOf({ api_error_status: 401 })).toEqual({ kind: "auth", status: 401 });
    expect(failureOf({ api_error_status: 400 })).toEqual({ kind: "request", status: 400 });
    expect(failureOf({ api_error_status: 429 })).toEqual({ kind: "transient", status: 429 });
    expect(failureOf({ api_error_status: null, api_error: "connection_failed" })).toEqual({
      kind: "transient",
    });
  });

  test("the plan's limit is its own failure, with when it resets, live or read again", () => {
    const limit = {
      api_error_status: 429,
      api_error: "usage_limit_reached",
      api_error_params: {
        rate_limit_info: {
          status: "rejected",
          resetsAt: 1_795_288_731,
          rateLimitType: "five_hour",
        },
      },
    };
    const text = "You've hit your 5-hour limit · resets 4:18am (Asia/Seoul)";
    const live = applyLines(emptyModel(), claudeFailure(limit, text));
    expect(live.lastResult?.failure).toEqual({ kind: "usage_limit", status: 429 });
    expect(live.rateLimit).toEqual({
      status: "rejected",
      resetsAt: 1_795_288_731,
      rateLimitType: "five_hour",
    });

    const replayed = applyTranscriptLines(
      transcriptLines([
        {
          type: "assistant",
          uuid: "u1",
          timestamp: "2026-11-21T18:18:52.902Z",
          message: { id: "m1", model: "<synthetic>", content: [{ type: "text", text }] },
          isApiErrorMessage: true,
          error: "rate_limit",
          apiError: "usage_limit_reached",
          apiErrorStatus: 429,
          apiErrorParams: limit.api_error_params,
        },
      ]),
    );
    expect(replayed.items).toEqual([
      expect.objectContaining({ kind: "notice", code: "error", detail: text }),
    ]);
    expect(replayed.rateLimit?.status).toBe("rejected");
  });
});

describe("a Codex turn that failed", () => {
  const failed = (error: Record<string, unknown>) =>
    applyCodexLines(
      { ...emptyCodexModel(), threadId: "t" },
      [
        {
          seq: 1,
          at: 1_000,
          dir: "out",
          message: { method: "turn/started", params: { threadId: "t", turn: { id: "turn" } } },
        },
        {
          seq: 2,
          at: 2_000,
          dir: "out",
          message: {
            method: "turn/completed",
            params: { threadId: "t", turn: { id: "turn", status: "failed", items: [], error } },
          },
        },
      ],
      1_000,
    ).lastResult?.failure;

  test("says what failed from its codexErrorInfo", () => {
    expect(
      failed({
        message: "exceeded retry limit, last status: 429 Too Many Requests",
        codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
      }),
    ).toEqual({ kind: "transient", status: 429 });
    expect(
      failed({
        message: "unexpected status 401 Unauthorized: Incorrect API key provided",
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
      }),
    ).toEqual({ kind: "auth", status: 401 });
    expect(failed({ message: "Invalid value", codexErrorInfo: "badRequest" })).toEqual({
      kind: "request",
    });
    expect(
      failed({
        message: "You’ve hit your usage limit. … try again at 4:29 AM.",
        codexErrorInfo: "usageLimitExceeded",
      }),
    ).toEqual({ kind: "usage_limit" });
    expect(failed({ message: "quota" })).toBeUndefined();
  });
});
