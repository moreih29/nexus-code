import { expect, jest, test } from "bun:test";
import * as React from "react";
import { LOADING_FLASH_DELAY_MS } from "../../../../src/renderer/components/files/file-tree/metrics";
import { useLoaderDelay } from "../../../../src/renderer/components/files/search/use-loader-delay";
import { useDelayedLoading } from "../../../../src/renderer/hooks/use-delayed-loading";

interface Dispatcher {
  useEffect(effect: React.EffectCallback, deps: React.DependencyList): void;
  useRef(initial: unknown): { current: unknown };
  useState(initial: boolean): [boolean, (next: boolean) => void];
}

function mount(hook: (loading: boolean) => boolean) {
  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: Dispatcher | null };
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const ref = { current: null as unknown };
  let shown = false;
  let deps: React.DependencyList = [];
  let cleanup: ReturnType<React.EffectCallback>;
  let commit: (() => void) | undefined;

  const dispatcher: Dispatcher = {
    useEffect(effect, next) {
      if (deps.length === next.length && next.every((value, i) => Object.is(deps[i], value)))
        return;
      commit = () => {
        cleanup?.();
        deps = next;
        cleanup = effect();
      };
    },
    useRef: () => ref,
    useState: () => [
      shown,
      (next) => {
        shown = next;
      },
    ],
  };

  return {
    render(loading: boolean) {
      const previous = internals.H;
      internals.H = dispatcher;
      try {
        return hook(loading);
      } finally {
        internals.H = previous;
        const finish = commit;
        commit = undefined;
        finish?.();
      }
    },
    unmount() {
      cleanup?.();
    },
  };
}

test.each([
  {
    view: "file tree",
    run: (loading: boolean) => useDelayedLoading(loading, LOADING_FLASH_DELAY_MS),
    delay: 200,
  },
  {
    view: "search and Source Control",
    run: (loading: boolean) => useLoaderDelay(loading ? "running" : "done"),
    delay: 250,
  },
])("$view preserves its loader threshold, quick completion and unmount cancellation", ({
  run,
  delay,
}) => {
  jest.useFakeTimers();
  const view = mount(run);
  try {
    expect(view.render(true)).toBe(false);
    jest.advanceTimersByTime(delay - 1);
    expect(view.render(true)).toBe(false);
    view.render(false);
    jest.advanceTimersByTime(1);
    expect(view.render(false)).toBe(false);

    view.render(true);
    jest.advanceTimersByTime(delay);
    expect(view.render(true)).toBe(true);
    view.render(false);
    expect(view.render(false)).toBe(false);

    view.render(true);
    view.unmount();
    jest.advanceTimersByTime(delay);
    expect(view.render(false)).toBe(false);
  } finally {
    view.unmount();
    jest.useRealTimers();
  }
});
