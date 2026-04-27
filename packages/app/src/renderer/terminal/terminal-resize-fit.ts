import type { ShellTerminalTabs } from "./shell-terminal-tab";

export interface TerminalResizeFitDisposable {
  dispose(): void;
}

export interface TerminalResizeFitWindowLike {
  ResizeObserver?: ResizeObserverConstructorLike;
  addEventListener?(type: "resize", listener: () => void): void;
  removeEventListener?(type: "resize", listener: () => void): void;
  requestAnimationFrame?(callback: () => void): number;
  cancelAnimationFrame?(handle: number): void;
}

export interface ResizeObserverLike {
  observe(target: Element): void;
  disconnect(): void;
}

export type ResizeObserverConstructorLike = new (
  callback: () => void,
) => ResizeObserverLike;

export interface InstallTerminalHostResizeFitOptions {
  host: HTMLElement;
  getTerminalTabs(): Pick<ShellTerminalTabs, "fitActiveTab"> | null | undefined;
  windowLike?: TerminalResizeFitWindowLike | null;
}

export function installTerminalHostResizeFit({
  host,
  getTerminalTabs,
  windowLike = resolveHostWindow(host),
}: InstallTerminalHostResizeFitOptions): TerminalResizeFitDisposable {
  let animationFrameHandle: number | null = null;
  let disposed = false;

  const runFit = (): void => {
    animationFrameHandle = null;
    if (disposed) {
      return;
    }

    getTerminalTabs()?.fitActiveTab();
  };

  const scheduleFit = (): void => {
    if (disposed || animationFrameHandle !== null) {
      return;
    }

    if (windowLike?.requestAnimationFrame) {
      animationFrameHandle = windowLike.requestAnimationFrame(runFit);
      return;
    }

    runFit();
  };

  const ResizeObserverCtor = windowLike?.ResizeObserver;
  const resizeObserver = ResizeObserverCtor ? new ResizeObserverCtor(scheduleFit) : null;
  resizeObserver?.observe(host);
  windowLike?.addEventListener?.("resize", scheduleFit);
  scheduleFit();

  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      resizeObserver?.disconnect();
      windowLike?.removeEventListener?.("resize", scheduleFit);
      if (animationFrameHandle !== null) {
        windowLike?.cancelAnimationFrame?.(animationFrameHandle);
        animationFrameHandle = null;
      }
    },
  };
}

function resolveHostWindow(host: HTMLElement): TerminalResizeFitWindowLike | null {
  return host.ownerDocument?.defaultView ?? null;
}
