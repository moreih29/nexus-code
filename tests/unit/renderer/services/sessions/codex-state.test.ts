/**
 * A Codex tab's state for the sessions tab and the inbox, read from its
 * conversation: what waits on the user, what runs, and a turn that ended
 * while the user looked elsewhere.
 */
import { describe, expect, it } from "bun:test";
import type {
  AssistantItem,
  ChatModel,
  PermissionRequest,
  UserItem,
} from "../../../../../src/renderer/services/chat/model";
import { type ChatTabState, emptyTabState } from "../../../../../src/renderer/services/chat/store";
import { codexStateOf } from "../../../../../src/renderer/services/sessions/codex-state";

const STARTED = 10_000;

function chat(
  model: Partial<ChatModel> = {},
  phase: ChatTabState["phase"] = "ready",
): ChatTabState {
  const empty = emptyTabState();
  return { ...empty, phase, model: { ...empty.model, ...model } };
}

function permission(toolName: string): PermissionRequest {
  return { requestId: `r-${toolName}`, toolName, input: {}, suggestions: [] };
}

const user = (text: string): UserItem =>
  ({ kind: "user", key: `u-${text}`, text, images: [], state: "taken" }) as UserItem;

const answer = (text: string): AssistantItem => ({
  kind: "assistant",
  key: `a-${text}`,
  messageId: `m-${text}`,
  blocks: [{ type: "text", text }],
});

const ended = (at: number, subtype = "completed") => ({
  lastResult: { subtype, isError: subtype === "failed", at },
});

describe("codexStateOf", () => {
  it("is idle for a tab whose view has not been shown", () => {
    expect(codexStateOf(undefined, undefined, false, STARTED)).toEqual({
      state: "idle",
      since: undefined,
      message: undefined,
      prompt: undefined,
    });
  });

  it("waits on the user for a permission, or for an answer to a question", () => {
    const turn = { startedAt: 12_000, outputTokens: 0, thinkingTokens: 0 };
    const asking = chat({ running: true, turn, permissions: [permission("Bash")] });
    expect(codexStateOf(asking, undefined, false, STARTED)).toMatchObject({
      state: "permissionPending",
      since: 12_000,
    });
    const questioning = chat({
      running: true,
      turn,
      permissions: [permission("Bash"), permission("AskUserQuestion")],
    });
    expect(codexStateOf(questioning, undefined, true, STARTED).state).toBe("needsInput");
  });

  it("runs while its turn does", () => {
    const turn = { startedAt: 12_000, outputTokens: 0, thinkingTokens: 0 };
    expect(codexStateOf(chat({ running: true, turn }), undefined, false, STARTED)).toMatchObject({
      state: "running",
      since: 12_000,
    });
  });

  it("is an error when its process failed or its thread is gone", () => {
    expect(codexStateOf(chat({}, "failed"), undefined, false, STARTED).state).toBe("error");
    expect(codexStateOf(chat({}, "not-found"), undefined, false, STARTED).state).toBe("error");
  });

  it("has a new result until the user looks at the tab after its turn ended", () => {
    const done = chat(ended(20_000));
    expect(codexStateOf(done, undefined, false, STARTED)).toMatchObject({
      state: "completed",
      since: 20_000,
    });
    expect(codexStateOf(done, 15_000, false, STARTED).state).toBe("completed");
    expect(codexStateOf(done, 20_000, false, STARTED).state).toBe("idle");
    expect(codexStateOf(done, undefined, true, STARTED).state).toBe("idle");
  });

  it("tells a failed turn as an error until looked at", () => {
    expect(codexStateOf(chat(ended(20_000, "failed")), undefined, false, STARTED).state).toBe(
      "error",
    );
  });

  it("does not count a turn the user stopped, or one before the app started", () => {
    expect(codexStateOf(chat(ended(20_000, "interrupted")), undefined, false, STARTED).state).toBe(
      "idle",
    );
    expect(codexStateOf(chat(ended(5_000)), undefined, false, STARTED).state).toBe("idle");
    expect(
      codexStateOf(
        chat({ lastResult: { subtype: "completed", isError: false } }),
        undefined,
        false,
        STARTED,
      ).state,
    ).toBe("idle");
  });

  it("tells the last prompt and the answer to it", () => {
    const told = chat({
      items: [user("old"), answer("Old."), user("  list files "), answer("Two files.")],
    });
    expect(codexStateOf(told, undefined, false, STARTED)).toMatchObject({
      prompt: "list files",
      message: "Two files.",
    });
    const unanswered = chat({ items: [user("old"), answer("Old."), user("next")] });
    expect(codexStateOf(unanswered, undefined, false, STARTED)).toMatchObject({
      prompt: "next",
      message: undefined,
    });
  });
});
