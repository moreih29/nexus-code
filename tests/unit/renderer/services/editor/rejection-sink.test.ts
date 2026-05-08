import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installRejectionSink } from "../../../../../src/renderer/services/editor/rejection-sink";

type Listener = (event: { reason: unknown; preventDefault(): void }) => void;
let listener: Listener | null = null;
beforeEach(() => {
  listener = null;
  (globalThis as any).window = {
    addEventListener(type: string, next: Listener): void {
      if (type === "unhandledrejection") {
        listener = next;
      }
    },
    removeEventListener(type: string, next: Listener): void {
      if (type === "unhandledrejection" && listener === next) {
        listener = null;
      }
    },
  };
});

afterEach(() => {
  delete (globalThis as any).window;
  listener = null;
});
function dispatch(reason: unknown): boolean {
  let prevented = false;
  listener?.({
    reason,
    preventDefault: () => {
      prevented = true;
    },
  });
  return prevented;
}
function expectSwallow(reason: unknown, expected: boolean): void {
  const dispose = installRejectionSink();
  expect(dispatch(reason)).toBe(expected);
  dispose();
}

describe("installRejectionSink", () => {
  it("swallows Canceled by name", () => {
    expectSwallow({ name: "Canceled" }, true);
  });

  it("swallows Canceled by message", () => {
    expectSwallow({ message: "Canceled" }, true);
  });

  it("does not swallow a normal Error", () => {
    expectSwallow(new Error("Boom"), false);
  });

  it("removes the listener on dispose", () => {
    const dispose = installRejectionSink();
    dispose();
    expect(dispatch({ name: "Canceled" })).toBe(false);
  });
});
