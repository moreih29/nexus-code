/**
 * A Codex tab's state for the sessions tab and the inbox, read from its
 * conversation: what waits on the user, what runs, and a turn that ended
 * while the user looked elsewhere.
 */
import { describe, expect, it } from "bun:test";
import type { ChatModel } from "../../../../../src/renderer/services/chat/model";
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

const ended = (at: number, subtype = "completed") => ({
  lastResult: { subtype, isError: subtype === "failed", at },
});

describe("codexStateOf", () => {
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
});
