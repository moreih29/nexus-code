import { describe, expect, test } from "bun:test";
import { createKeyedListenerBus, createListenerBus } from "../../../src/shared/util/listener-bus";

describe("createListenerBus", () => {
  test("subscribe during notify does not cause infinite recursion", () => {
    const bus = createListenerBus<void>();
    let subscribed = false;
    bus.subscribe(() => {
      if (!subscribed) {
        subscribed = true;
        bus.subscribe(() => {});
      }
    });
    expect(() => bus.notify()).not.toThrow();
    expect(bus.size).toBe(2);
  });

  test("unsubscribe during notify is safe (snapshot iteration)", () => {
    const bus = createListenerBus<void>();
    const called: number[] = [];
    let unsub2: (() => void) | undefined;
    bus.subscribe(() => {
      called.push(1);
      unsub2?.();
    });
    unsub2 = bus.subscribe(() => {
      called.push(2);
    });
    // Both listeners are snapshotted before iteration starts, so both run
    // during the first notify even though unsub2 is called mid-flight.
    bus.notify();
    expect(called).toEqual([1, 2]);
    // After the first notify, listener 2 has been removed — only 1 runs now.
    bus.notify();
    expect(called).toEqual([1, 2, 1]);
  });
});

describe("createKeyedListenerBus", () => {
  test("unsubscribing last listener for a key removes the key entry", () => {
    const bus = createKeyedListenerBus<string, void>();
    const unsub = bus.subscribe("k", () => {});
    expect(bus.keyCount).toBe(1);
    unsub();
    expect(bus.keyCount).toBe(0);
    expect(bus.sizeFor("k")).toBe(0);
  });

  test("snapshot iteration: unsubscribe during notify is safe", () => {
    const bus = createKeyedListenerBus<string, void>();
    const called: number[] = [];
    let unsub2: (() => void) | undefined;
    bus.subscribe("k", () => {
      called.push(1);
      unsub2?.();
    });
    unsub2 = bus.subscribe("k", () => {
      called.push(2);
    });
    // Both listeners are snapshotted before iteration starts, so both run
    // during the first notify even though unsub2 is called mid-flight.
    bus.notify("k");
    expect(called).toEqual([1, 2]);
    // After the first notify, listener 2 has been removed — only 1 runs now.
    bus.notify("k");
    expect(called).toEqual([1, 2, 1]);
  });
});
