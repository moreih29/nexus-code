import { expect, test } from "bun:test";
import {
  fitTextHeight,
  observeTextHeight,
} from "../../../../../src/renderer/components/chat/composer-height";

function textarea() {
  const element = {
    offsetWidth: 62,
    clientWidth: 52,
    style: { height: "52px", overflowY: "" },
    closest: () => null,
    get scrollHeight() {
      if (this.style.overflowY === "hidden") return 52;
      return this.style.height === "52px" || this.clientWidth === 52 ? 71 : 52;
    },
  };
  return { element, area: element as unknown as HTMLTextAreaElement };
}

test("measures the same height with or without the textarea's scrollbar", () => {
  const { area, element } = textarea();
  fitTextHeight(area, null);
  expect(element.style).toEqual({ height: "71px", overflowY: "" });

  element.clientWidth = 62;
  fitTextHeight(area, null);
  expect(element.style).toEqual({ height: "71px", overflowY: "" });
});

test("scrollbar changes alone do not schedule a fit; size changes wait for one frame", () => {
  const { area, element } = textarea();
  const column = { clientHeight: 694 };
  let notify: (() => void) | undefined;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let disconnected = false;
  const original = {
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      notify = () => callback([], this);
    }
    observe() {}
    unobserve() {}
    disconnect() {
      disconnected = true;
    }
  };
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  globalThis.cancelAnimationFrame = (handle) => void frames.delete(handle);

  try {
    const stop = observeTextHeight(area, column as HTMLElement);
    element.clientWidth = 62;
    notify?.();
    expect(frames.size).toBe(0);

    element.offsetWidth = 63;
    notify?.();
    column.clientHeight = 710;
    notify?.();
    expect(frames.size).toBe(1);
    expect(element.style.height).toBe("52px");

    const frame = frames.get(1);
    frames.delete(1);
    frame?.(0);
    expect(element.style.height).toBe("71px");
    notify?.();
    expect(frames.size).toBe(0);

    element.offsetWidth = 64;
    notify?.();
    expect(frames.size).toBe(1);
    stop();
    expect(frames.size).toBe(0);
    expect(disconnected).toBe(true);
  } finally {
    Object.assign(globalThis, original);
  }
});
