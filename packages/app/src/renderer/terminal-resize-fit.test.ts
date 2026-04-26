import { describe, expect, test } from "bun:test";

import {
  installTerminalHostResizeFit,
  type ResizeObserverConstructorLike,
  type ResizeObserverLike,
} from "./terminal-resize-fit";

describe("installTerminalHostResizeFit", () => {
  test("observes host/window resize and batches active terminal fit calls", () => {
    const fakeWindow = new FakeWindow();
    let fitCount = 0;

    const disposable = installTerminalHostResizeFit({
      host: {} as HTMLElement,
      getTerminalTabs: () => ({
        fitActiveTab() {
          fitCount += 1;
          return true;
        },
      }),
      windowLike: fakeWindow,
    });

    fakeWindow.flushAnimationFrames();
    expect(fitCount).toBe(1);
    expect(fakeWindow.resizeObserver?.observedTargets).toHaveLength(1);

    fakeWindow.resizeObserver?.trigger();
    fakeWindow.dispatchResize();
    expect(fitCount).toBe(1);

    fakeWindow.flushAnimationFrames();
    expect(fitCount).toBe(2);

    disposable.dispose();
    fakeWindow.resizeObserver?.trigger();
    fakeWindow.dispatchResize();
    fakeWindow.flushAnimationFrames();
    expect(fitCount).toBe(2);
    expect(fakeWindow.resizeObserver?.disconnectCount).toBe(1);
  });
});

class FakeWindow {
  public resizeObserver: FakeResizeObserver | null = null;
  public readonly ResizeObserver: ResizeObserverConstructorLike;
  private readonly resizeListeners = new Set<() => void>();
  private readonly animationFrames = new Map<number, () => void>();
  private nextAnimationFrameHandle = 1;

  public constructor() {
    const setLatestResizeObserver = (observer: FakeResizeObserver): void => {
      this.resizeObserver = observer;
    };

    this.ResizeObserver = class implements ResizeObserverLike {
      private readonly callback: () => void;
      public readonly observedTargets: Element[] = [];
      public disconnectCount = 0;

      public constructor(callback: () => void) {
        this.callback = callback;
        setLatestResizeObserver(this);
      }

      public observe(target: Element): void {
        this.observedTargets.push(target);
      }

      public disconnect(): void {
        this.disconnectCount += 1;
      }

      public trigger(): void {
        this.callback();
      }
    } as ResizeObserverConstructorLike;
  }

  public addEventListener(type: "resize", listener: () => void): void {
    if (type === "resize") {
      this.resizeListeners.add(listener);
    }
  }

  public removeEventListener(type: "resize", listener: () => void): void {
    if (type === "resize") {
      this.resizeListeners.delete(listener);
    }
  }

  public requestAnimationFrame(callback: () => void): number {
    const handle = this.nextAnimationFrameHandle;
    this.nextAnimationFrameHandle += 1;
    this.animationFrames.set(handle, callback);
    return handle;
  }

  public cancelAnimationFrame(handle: number): void {
    this.animationFrames.delete(handle);
  }

  public dispatchResize(): void {
    for (const listener of this.resizeListeners) {
      listener();
    }
  }

  public flushAnimationFrames(): void {
    const callbacks = Array.from(this.animationFrames.values());
    this.animationFrames.clear();
    for (const callback of callbacks) {
      callback();
    }
  }
}

type FakeResizeObserver = ResizeObserverLike & {
  observedTargets: Element[];
  disconnectCount: number;
  trigger(): void;
};
