import { afterEach, describe, expect, test } from "bun:test";
import * as React from "react";

import type {
  ClaudeSettingsConsentRequest,
  ClaudeSettingsConsentResponse,
} from "../../../../../shared/src/contracts/claude/claude-settings";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import { useClaudeConsentDialog } from "./useClaudeConsentDialog";

const originalWindow = globalThis.window;

afterEach(() => {
  if (originalWindow) {
    globalThis.window = originalWindow;
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("useClaudeConsentDialog", () => {
  test("receives consent requests from the IPC subscription", () => {
    const ipc = installClaudeSettingsStub();
    const runner = createHookRunner(() => useClaudeConsentDialog());

    let dialog = runner.render();
    expect(dialog.request).toBeNull();
    expect(ipc.listeners.length).toBe(1);

    ipc.listeners[0]?.(createRequest("request_1"));
    dialog = runner.render();

    expect(dialog.request?.requestId).toBe("request_1");
    expect(dialog.request?.workspaceName).toBe("Alpha");
    expect(dialog.dontAskAgain.checked).toBe(false);

    runner.unmount();
    expect(ipc.disposeCount).toBe(1);
  });

  test("completes the pending request with the approval decision", () => {
    const ipc = installClaudeSettingsStub();
    const runner = createHookRunner(() => useClaudeConsentDialog());

    let dialog = runner.render();
    ipc.listeners[0]?.(createRequest("request_2"));
    dialog = runner.render();
    dialog.dontAskAgain.set(true);
    dialog = runner.render();

    dialog.complete(true, dialog.dontAskAgain.checked);
    dialog = runner.render();

    expect(dialog.request).toBeNull();
    expect(dialog.dontAskAgain.checked).toBe(false);
    expect(ipc.responses).toEqual([
      { requestId: "request_2", approved: true, dontAskAgain: true },
    ]);

    runner.unmount();
  });

  test("dismisses the pending request as denied", () => {
    const ipc = installClaudeSettingsStub();
    const runner = createHookRunner(() => useClaudeConsentDialog());

    let dialog = runner.render();
    ipc.listeners[0]?.(createRequest("request_3"));
    dialog = runner.render();

    dialog.dismiss();
    dialog = runner.render();

    expect(dialog.request).toBeNull();
    expect(ipc.responses).toEqual([
      { requestId: "request_3", approved: false, dontAskAgain: false },
    ]);

    runner.unmount();
  });
});

interface ClaudeSettingsStub {
  listeners: Array<(request: ClaudeSettingsConsentRequest) => void>;
  responses: ClaudeSettingsConsentResponse[];
  disposeCount: number;
}

function installClaudeSettingsStub(): ClaudeSettingsStub {
  const stub: ClaudeSettingsStub = {
    listeners: [],
    responses: [],
    disposeCount: 0,
  };

  globalThis.window = {
    nexusClaudeSettings: {
      onConsentRequest(listener) {
        stub.listeners.push(listener);
        return {
          dispose() {
            stub.disposeCount += 1;
          },
        };
      },
      async respondConsentRequest(response) {
        stub.responses.push(response);
      },
    },
  } as unknown as Window & typeof globalThis;

  return stub;
}

function createRequest(requestId: string): ClaudeSettingsConsentRequest {
  return {
    requestId,
    workspaceId: "ws_alpha" as WorkspaceId,
    workspaceName: "Alpha",
    workspacePath: "/tmp/alpha",
    harnessName: "Claude Code",
    settingsFiles: [".claude/settings.local.json"],
  };
}

interface HookRunner<T> {
  render(): T;
  unmount(): void;
}

function createHookRunner<T>(hook: () => T): HookRunner<T> {
  const internals = (React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
  }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const stateSlots: unknown[] = [];
  const refSlots: Array<{ current: unknown } | undefined> = [];
  const memoSlots: Array<{ value: unknown; deps?: readonly unknown[] | null } | undefined> = [];
  const effectSlots: Array<{
    deps?: readonly unknown[] | null;
    cleanup?: void | (() => void);
  } | undefined> = [];
  const pendingEffects: Array<{ index: number; effect: () => void | (() => void) }> = [];
  let hookIndex = 0;

  const dispatcher = {
    useCallback(callback: unknown, deps?: readonly unknown[] | null) {
      return dispatcher.useMemo(() => callback, deps);
    },
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[] | null) {
      const index = hookIndex++;
      const previous = effectSlots[index];
      if (!previous || !areHookDepsEqual(previous.deps, deps)) {
        pendingEffects.push({ index, effect });
      }
      effectSlots[index] = {
        deps,
        cleanup: previous?.cleanup,
      };
    },
    useMemo(factory: () => unknown, deps?: readonly unknown[] | null) {
      const index = hookIndex++;
      const previous = memoSlots[index];
      if (previous && areHookDepsEqual(previous.deps, deps)) {
        return previous.value;
      }
      const value = factory();
      memoSlots[index] = { value, deps };
      return value;
    },
    useRef(initialValue: unknown) {
      const index = hookIndex++;
      refSlots[index] ??= { current: initialValue };
      return refSlots[index];
    },
    useState(initialValue: unknown) {
      const index = hookIndex++;
      if (!(index in stateSlots)) {
        stateSlots[index] = typeof initialValue === "function"
          ? (initialValue as () => unknown)()
          : initialValue;
      }
      const setState = (nextValue: unknown) => {
        stateSlots[index] = typeof nextValue === "function"
          ? (nextValue as (previous: unknown) => unknown)(stateSlots[index])
          : nextValue;
      };
      return [stateSlots[index], setState];
    },
  };

  return {
    render() {
      hookIndex = 0;
      const previousDispatcher = internals.H;
      internals.H = dispatcher;
      try {
        const result = hook();
        runPendingEffects(effectSlots, pendingEffects);
        return result;
      } finally {
        internals.H = previousDispatcher;
      }
    },
    unmount() {
      for (const slot of effectSlots) {
        slot?.cleanup?.();
        if (slot) {
          slot.cleanup = undefined;
        }
      }
    },
  };
}

function runPendingEffects(
  effectSlots: Array<{ cleanup?: void | (() => void) } | undefined>,
  pendingEffects: Array<{ index: number; effect: () => void | (() => void) }>,
): void {
  for (const pendingEffect of pendingEffects.splice(0)) {
    effectSlots[pendingEffect.index]?.cleanup?.();
    const cleanup = pendingEffect.effect();
    if (effectSlots[pendingEffect.index]) {
      effectSlots[pendingEffect.index]!.cleanup = cleanup;
    }
  }
}

function areHookDepsEqual(
  previousDeps: readonly unknown[] | null | undefined,
  nextDeps: readonly unknown[] | null | undefined,
): boolean {
  if (!previousDeps || !nextDeps || previousDeps.length !== nextDeps.length) {
    return false;
  }

  return previousDeps.every((dependency, index) => Object.is(dependency, nextDeps[index]));
}
