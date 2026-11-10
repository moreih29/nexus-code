/**
 * The order the agent view's list is dragged into: the agents it names
 * first, as it names them, then the rest as they come; a drop puts one
 * just before or after another.
 */
import { describe, expect, it } from "bun:test";
import {
  moveKey,
  orderFromStore,
  orderSessions,
  orderToStore,
} from "../../../../../src/renderer/services/agent-view/order";

const rows = (...keys: string[]) => keys.map((key) => ({ key }));
const keysOf = (list: readonly { key: string }[]) => list.map((row) => row.key);

describe("the list's order", () => {
  it("lists the agents it names first, then the rest as they come", () => {
    const sessions = rows("a", "b", "c", "d");
    expect(keysOf(orderSessions(sessions, ["c", "a"]))).toEqual(["c", "a", "b", "d"]);
    // A name whose agent is gone is passed over.
    expect(keysOf(orderSessions(sessions, ["gone", "d"]))).toEqual(["d", "a", "b", "c"]);
  });

  it("keeps the same list while nothing moves", () => {
    const sessions = rows("a", "b", "c");
    expect(orderSessions(sessions, undefined)).toBe(sessions);
    expect(orderSessions(sessions, [])).toBe(sessions);
    expect(orderSessions(sessions, ["a", "b"])).toBe(sessions);
  });

  it("a drop puts the agent just before or after the one it lands on", () => {
    const keys = ["a", "b", "c", "d"];
    expect(moveKey(keys, "d", "b", "before")).toEqual(["a", "d", "b", "c"]);
    expect(moveKey(keys, "a", "c", "after")).toEqual(["b", "c", "a", "d"]);
    expect(moveKey(keys, "c", "d", "after")).toEqual(["a", "b", "d", "c"]);
    expect(moveKey(keys, "b", "b", "before")).toEqual(keys);
    expect(moveKey(keys, "x", "b", "before")).toEqual(keys);
    expect(moveKey(keys, "a", "x", "before")).toEqual(keys);
  });

  it("comes back with only the agents still there, and goes out as AppState keeps it", () => {
    const order = orderFromStore(
      { w1: ["w1:a", "w1:gone"], w2: ["w2:gone"] },
      (key) => !key.endsWith("gone"),
    );
    expect(order).toEqual({ w1: ["w1:a"] });
    expect(orderToStore(order)).toEqual({ w1: ["w1:a"] });
    expect(orderFromStore(undefined, () => true)).toEqual({});
  });
});
