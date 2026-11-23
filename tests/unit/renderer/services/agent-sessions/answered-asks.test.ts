import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  markAnswered,
  resetAnsweredAsks,
  unansweredAsks,
  useAnsweredAsksStore,
} from "../../../../../src/renderer/services/agent-sessions/answered-asks";
import type { PermissionAsk } from "../../../../../src/shared/claude/activity";

const session = { workspaceId: "ws", tabId: "tab" };
const ask = (id: string) => ({ id, tool: "Bash", always: [] }) as unknown as PermissionAsk;
const asks = [ask("a"), ask("b")];
const shown = () =>
  unansweredAsks(session, asks, useAnsweredAsksStore.getState().keys).map((each) => each.id);

beforeEach(resetAnsweredAsks);
afterEach(() => jest.useRealTimers());

describe("a request answered from the app", () => {
  test("leaves at once; the others stay", () => {
    expect(shown()).toEqual(["a", "b"]);
    markAnswered(session, "a");
    expect(shown()).toEqual(["b"]);
  });

  test("is another session's own: one of the same id there stays", () => {
    markAnswered({ workspaceId: "ws", tabId: "other" }, "a");
    expect(shown()).toEqual(["a", "b"]);
  });

  test("shows again if polls still list it a while later", () => {
    jest.useFakeTimers();
    markAnswered(session, "a", 20);
    expect(shown()).toEqual(["b"]);
    jest.advanceTimersByTime(19);
    expect(shown()).toEqual(["b"]);
    jest.advanceTimersByTime(1);
    expect(shown()).toEqual(["a", "b"]);
  });

  test("answered again, waits the while again", () => {
    jest.useFakeTimers();
    markAnswered(session, "a", 30);
    jest.advanceTimersByTime(15);
    markAnswered(session, "a", 30);
    jest.advanceTimersByTime(20);
    expect(shown()).toEqual(["b"]);
    jest.advanceTimersByTime(10);
    expect(shown()).toEqual(["a", "b"]);
  });

  test("with none answered, the list is the one polled", () => {
    expect(unansweredAsks(session, asks, new Set())).toBe(asks);
  });
});
