/**
 * Where a conversation went on in another profile: the line that says so
 * follows the last message before the move, found again by its id.
 */
import { describe, expect, test } from "bun:test";
import type { ChatItem } from "../../../../../src/renderer/services/chat/model";
import {
  followsMessage,
  lastMessageId,
  sameProfile,
  withMove,
} from "../../../../../src/renderer/services/chat/profile-moves";

const user = (key: string, uuid?: string) =>
  ({ kind: "user", key, text: key, ...(uuid ? { uuid } : {}) }) as ChatItem;
const answer = (key: string, messageId: string, uuid?: string) =>
  ({ kind: "assistant", key, messageId, blocks: [], ...(uuid ? { uuid } : {}) }) as ChatItem;
const notice = { kind: "notice", key: "n", code: "error", detail: "x" } as ChatItem;

describe("profile moves", () => {
  test("follow the last message: its uuid, else the message an answer is of", () => {
    expect(lastMessageId([user("u", "uu"), answer("a", "m", "au"), notice])).toBe("au");
    // Codex's answers have no uuid: the turn they belong to.
    expect(lastMessageId([user("u", "uu"), answer("a", "turn-1")])).toBe("turn-1");
    expect(lastMessageId([answer("a", "turn-1"), user("u", "uu")])).toBe("uu");
    expect(lastMessageId([user("u"), notice])).toBeUndefined();
  });

  test("find their message again by either id", () => {
    expect(followsMessage(answer("a", "turn-1"), "turn-1")).toBe(true);
    expect(followsMessage(answer("a", "m", "au"), "au")).toBe(true);
    expect(followsMessage(user("u", "uu"), "uu")).toBe(true);
    expect(followsMessage(notice, "uu")).toBe(false);
  });

  test("a move with no message since the last takes its place", () => {
    const first = { profileId: "work", after: "a", at: 1 };
    const back = { profileId: "claude-default", after: "a", at: 2 };
    const later = { profileId: "work", after: "b", at: 3 };
    expect(withMove(undefined, first)).toEqual([first]);
    expect(withMove([first], back)).toEqual([back]);
    expect(withMove([back], later)).toEqual([back, later]);
  });

  test("keep the latest only", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ profileId: "p", after: `m${i}`, at: i }));
    const kept = many.reduce<ReturnType<typeof withMove>>((all, move) => withMove(all, move), []);
    expect(kept).toHaveLength(20);
    expect(kept[0]?.after).toBe("m5");
  });

  test("the default profile is the default however it is named", () => {
    expect(sameProfile(undefined, "claude-default")).toBe(true);
    expect(sameProfile("codex-default", undefined)).toBe(true);
    expect(sameProfile("work", undefined)).toBe(false);
    expect(sameProfile("work", "work")).toBe(true);
  });
});
