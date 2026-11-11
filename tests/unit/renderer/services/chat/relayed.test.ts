/**
 * Messages another agent sends a tab through the nexus command: the line its
 * agent reads before one, and the tab showing it as received from that
 * agent, found by the records the tab keeps, not by what the text says.
 */
import { describe, expect, it } from "bun:test";
import type { ChatItem, UserItem } from "../../../../../src/renderer/services/chat/model";
import { followsMessage } from "../../../../../src/renderer/services/chat/profile-moves";
import { relaySenderText, withRelayed } from "../../../../../src/renderer/services/chat/relayed";
import {
  RELAYED_KEPT,
  type RelayedMessage,
  type RelaySender,
  relayedText,
  relayHeader,
  withoutRelayHeader,
  withRelayedMessage,
} from "../../../../../src/shared/chat/relay";

const TAB: RelaySender = {
  kind: "tab",
  agent: "claude",
  name: "Plan the refactor",
  workspaceId: "ws-1",
  tabId: "tab-1",
};

const user = (key: string, text: string, extra: Partial<UserItem> = {}): UserItem => ({
  kind: "user",
  key,
  text,
  images: [],
  state: "taken",
  ...extra,
});

const record = (id: string, extra: Partial<RelayedMessage> = {}): RelayedMessage => ({
  id,
  from: TAB,
  at: 1,
  ...extra,
});

describe("the line the agent reads", () => {
  it("names who sent it, says the user did not, and that the answer goes back", () => {
    expect(relayHeader(TAB)).toBe(
      '[nexus] The "Plan the refactor" tab (Claude) sent this, not the user. Your answer here is what it reads.',
    );
    expect(relayHeader({ kind: "terminal", agent: "codex", name: "zsh" })).toStartWith(
      '[nexus] Codex in the "zsh" terminal sent this, not the user.',
    );
    expect(relayHeader({ kind: "manager" })).toStartWith(
      "[nexus] The manager (an agent the user runs) sent this, not the user.",
    );
  });

  it("goes before the message, and comes off it again", () => {
    const text = relayedText(TAB, "Run the tests.\n\nThen tell me.");
    expect(text).toStartWith(`${relayHeader(TAB)}\n\nRun the tests.`);
    expect(withoutRelayHeader(text)).toBe("Run the tests.\n\nThen tell me.");
    expect(withoutRelayHeader("Run the tests.")).toBe("Run the tests.");
  });

  it("is kept for the latest messages, one record an id", () => {
    const told = withRelayedMessage([record("a"), record("b")], record("a", { turnId: "t1" }));
    expect(told.map((r) => [r.id, r.turnId])).toEqual([
      ["b", undefined],
      ["a", "t1"],
    ]);
    const many = Array.from({ length: RELAYED_KEPT + 3 }, (_, i) => record(`m${i}`));
    const kept = many.reduce<RelayedMessage[]>((all, r) => withRelayedMessage(all, r), []);
    expect(kept).toHaveLength(RELAYED_KEPT);
    expect(kept[0]?.id).toBe("m3");
  });
});

describe("withRelayed", () => {
  const said = relayedText(TAB, "Run the tests.");

  it("shows a message a record names as received from its sender, without the line", () => {
    const items: ChatItem[] = [user("u1", said, { uuid: "uuid-1", at: 5 }), user("u2", "mine")];
    const shown = withRelayed(items, [record("uuid-1")]);
    expect(shown[0]).toEqual({
      kind: "received",
      key: "u1",
      uuid: "uuid-1",
      from: TAB,
      text: "Run the tests.",
      at: 5,
    });
    expect(shown[1]).toBe(items[1] as ChatItem);
    // A line follows it as it followed the user's message.
    expect(followsMessage(shown[0] as ChatItem, "uuid-1")).toBe(true);
  });

  it("finds a Codex message by its client id, then by its turn once the thread renumbered it", () => {
    const live: ChatItem[] = [user("u-app-1", said, { state: "sent" })];
    expect(withRelayed(live, [record("app-1")])[0]?.kind).toBe("received");
    const resumed: ChatItem[] = [
      user("u1.0.0", "the user's first", { uuid: "item-1", turnId: "turn-1" }),
      user("u1.0.1", said, { uuid: "item-2", turnId: "turn-1" }),
      user("u1.1.0", said, { uuid: "item-3", turnId: "turn-2" }),
    ];
    const shown = withRelayed(resumed, [
      record("app-1", { turnId: "turn-1" }),
      record("app-2", { turnId: "turn-2", from: { kind: "manager" } }),
    ]);
    expect(shown.map((i) => i.kind)).toEqual(["user", "received", "received"]);
    expect(shown[2]?.kind === "received" && shown[2].from).toEqual({ kind: "manager" });
  });

  it("leaves the user's own text that looks the same, and every item when no record names one", () => {
    const items: ChatItem[] = [user("u1", said, { uuid: "uuid-9" })];
    expect(withRelayed(items, [record("uuid-1")])).toBe(items);
    expect(withRelayed(items, undefined)).toBe(items);
  });

  it("shows the same item for the same message each time, so the list does not render it again", () => {
    const items: ChatItem[] = [user("u1", said, { uuid: "uuid-1" })];
    const records = [record("uuid-1")];
    const first = withRelayed(items, records)[0];
    expect(withRelayed([...items, user("u2", "mine")], [...records])[0]).toBe(first as ChatItem);
    // Another record for it shows it anew.
    const other = withRelayed(items, [record("uuid-1", { from: { kind: "manager" } })])[0];
    expect(other).not.toBe(first as ChatItem);
    expect(other?.kind === "received" && other.from).toEqual({ kind: "manager" });
  });

  it("keeps one still waiting for the agent where it waits, without the line", () => {
    const waiting = user("u1", said, { state: "sent", queued: true, sentUuid: "uuid-1" });
    const [shown] = withRelayed([waiting], [record("uuid-1")]);
    expect(shown).toEqual({ ...waiting, text: "Run the tests." });
  });

  it("names the sender in words for chat read and /export", () => {
    expect(relaySenderText(TAB)).toBe('tab "Plan the refactor"');
    expect(relaySenderText({ kind: "terminal", agent: "codex", name: "zsh" })).toBe(
      'Codex in terminal "zsh"',
    );
    expect(relaySenderText({ kind: "manager" })).toBe("the manager");
    expect(relaySenderText({ kind: "peer", name: "other" })).toBeUndefined();
  });
});
