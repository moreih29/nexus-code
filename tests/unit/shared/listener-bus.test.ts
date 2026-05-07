import { describe, expect, test } from "bun:test";
import { createKeyedListenerBus, createListenerBus } from "../../../src/shared/listener-bus";

describe("createListenerBus", () => {
  test("notifies subscribed listener", () => {
    const bus = createListenerBus<number>();
    const received: number[] = [];
    bus.subscribe((v) => received.push(v));
    bus.notify(42);
    expect(received).toEqual([42]);
  });

  test("unsubscribe stops further notifications", () => {
    const bus = createListenerBus<number>();
    const received: number[] = [];
    const unsub = bus.subscribe((v) => received.push(v));
    bus.notify(1);
    unsub();
    bus.notify(2);
    expect(received).toEqual([1]);
  });

  test("clear removes all listeners", () => {
    const bus = createListenerBus<number>();
    const received: number[] = [];
    bus.subscribe((v) => received.push(v));
    bus.subscribe((v) => received.push(v * 10));
    bus.clear();
    bus.notify(5);
    expect(received).toEqual([]);
    expect(bus.size).toBe(0);
  });

  test("size reflects current listener count", () => {
    const bus = createListenerBus<void>();
    expect(bus.size).toBe(0);
    const unsub1 = bus.subscribe(() => {});
    expect(bus.size).toBe(1);
    const unsub2 = bus.subscribe(() => {});
    expect(bus.size).toBe(2);
    unsub1();
    expect(bus.size).toBe(1);
    unsub2();
    expect(bus.size).toBe(0);
  });

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

  test("void bus can be called with no argument", () => {
    const bus = createListenerBus();
    let calls = 0;
    bus.subscribe(() => calls++);
    bus.notify();
    expect(calls).toBe(1);
  });
});

describe("createKeyedListenerBus", () => {
  test("notifies only listeners for the given key", () => {
    const bus = createKeyedListenerBus<string, number>();
    const aReceived: number[] = [];
    const bReceived: number[] = [];
    bus.subscribe("a", (v) => aReceived.push(v));
    bus.subscribe("b", (v) => bReceived.push(v));
    bus.notify("a", 1);
    expect(aReceived).toEqual([1]);
    expect(bReceived).toEqual([]);
  });

  test("unsubscribe stops further notifications for that key", () => {
    const bus = createKeyedListenerBus<string, number>();
    const received: number[] = [];
    const unsub = bus.subscribe("x", (v) => received.push(v));
    bus.notify("x", 10);
    unsub();
    bus.notify("x", 20);
    expect(received).toEqual([10]);
  });

  test("clearKey removes all listeners for that key only", () => {
    const bus = createKeyedListenerBus<string, number>();
    const aReceived: number[] = [];
    const bReceived: number[] = [];
    bus.subscribe("a", (v) => aReceived.push(v));
    bus.subscribe("b", (v) => bReceived.push(v));
    bus.clearKey("a");
    bus.notify("a", 1);
    bus.notify("b", 2);
    expect(aReceived).toEqual([]);
    expect(bReceived).toEqual([2]);
  });

  test("clear removes all listeners across all keys", () => {
    const bus = createKeyedListenerBus<string, number>();
    const received: number[] = [];
    bus.subscribe("a", (v) => received.push(v));
    bus.subscribe("b", (v) => received.push(v));
    bus.clear();
    bus.notify("a", 1);
    bus.notify("b", 2);
    expect(received).toEqual([]);
    expect(bus.keyCount).toBe(0);
  });

  test("sizeFor returns count for a specific key", () => {
    const bus = createKeyedListenerBus<string, void>();
    expect(bus.sizeFor("k")).toBe(0);
    const unsub1 = bus.subscribe("k", () => {});
    expect(bus.sizeFor("k")).toBe(1);
    bus.subscribe("k", () => {});
    expect(bus.sizeFor("k")).toBe(2);
    unsub1();
    expect(bus.sizeFor("k")).toBe(1);
  });

  test("keyCount reflects number of keys with active listeners", () => {
    const bus = createKeyedListenerBus<string, void>();
    expect(bus.keyCount).toBe(0);
    const unsubA = bus.subscribe("a", () => {});
    expect(bus.keyCount).toBe(1);
    bus.subscribe("b", () => {});
    expect(bus.keyCount).toBe(2);
    unsubA();
    expect(bus.keyCount).toBe(1);
  });

  test("unsubscribing last listener for a key removes the key entry", () => {
    const bus = createKeyedListenerBus<string, void>();
    const unsub = bus.subscribe("k", () => {});
    expect(bus.keyCount).toBe(1);
    unsub();
    expect(bus.keyCount).toBe(0);
    expect(bus.sizeFor("k")).toBe(0);
  });

  test("notify on missing key is a no-op", () => {
    const bus = createKeyedListenerBus<string, number>();
    expect(() => bus.notify("missing", 99)).not.toThrow();
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
