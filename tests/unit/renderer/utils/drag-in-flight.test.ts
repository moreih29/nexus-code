import { describe, expect, test } from "bun:test";
import { beginDragInFlight, DND_ACTIVE_ATTR } from "../../../../src/renderer/utils/drag-in-flight";

function fakeDoc() {
  const attrs = new Set<string>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    attrs,
    fire(type: string) {
      for (const l of [...(listeners.get(type) ?? [])]) l();
    },
    documentElement: {
      setAttribute: (n: string) => void attrs.add(n),
      removeAttribute: (n: string) => void attrs.delete(n),
    },
    addEventListener: (t: string, l: () => void) => {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t)?.add(l);
    },
    removeEventListener: (t: string, l: () => void) => void listeners.get(t)?.delete(l),
  };
}

describe("beginDragInFlight", () => {
  test("sets the flag and clears it on dragend", () => {
    const d = fakeDoc();
    beginDragInFlight(d);
    expect(d.attrs.has(DND_ACTIVE_ATTR)).toBe(true);
    d.fire("dragend");
    expect(d.attrs.has(DND_ACTIVE_ATTR)).toBe(false);
  });

  test("clears on drop and on a later pointerdown", () => {
    for (const type of ["drop", "pointerdown"]) {
      const d = fakeDoc();
      beginDragInFlight(d);
      d.fire(type);
      expect(d.attrs.has(DND_ACTIVE_ATTR)).toBe(false);
    }
  });

  test("end function is idempotent", () => {
    const d = fakeDoc();
    const end = beginDragInFlight(d);
    end();
    end();
    expect(d.attrs.size).toBe(0);
  });
});
