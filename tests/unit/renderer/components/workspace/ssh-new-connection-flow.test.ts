/**
 * Scenario tests for the SshNewConnectionView two-stage connect flow (T10).
 *
 * WHAT IS TESTED
 * --------------
 * The real component's handleConnect: submitting the returned <form> runs the
 * real useIpcAction → openSshBrowseSession → saveConnectionProfileResult chain
 * against a stubbed ipcCallResult. The connect phase is read from
 * onConnectPhaseChange, the prop the parent footer drives its button from.
 *
 * HOW IT RENDERS WITHOUT A DOM
 * ----------------------------
 * Following browser-view.test.tsx: a transparent `react` mock forwards hooks to
 * React's current-dispatcher slot, and mountView() points that slot at a
 * minimal slot-indexed dispatcher while the component body runs. The form is
 * seeded through prefillProfile so no input events are needed.
 *
 * SCENARIOS
 * ---------
 *   1. Happy path: connect ok + save ok → onConnected called, no toast.
 *   2. Partial failure (plan issue-8): connect ok + save fails →
 *        - onConnected is called (primary flow completes)
 *        - save-failed action toast with "Retry save", which replays only the save
 *        - phase exits connecting (no freeze)
 *   3. Connect failure → phase 'error' with the humanized inline message,
 *      onConnected NOT called, nothing saved.
 *   4. Auth cancellation → phase 'idle', no inline error (silent).
 *   5. Save rejects (throws instead of returning IpcErrResult) → phase exits connecting.
 *   6. Double-submit during in-flight connect → a single openBrowseSession call.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactElement } from "react";
import type { ToastInput } from "../../../../../src/renderer/components/ui/toast";
import type { SshBrowseSession } from "../../../../../src/renderer/components/workspace/add-workspace/types";
import { ipcErr, ipcOk } from "../../../../../src/shared/ipc/result";
import type { ConnectionProfile } from "../../../../../src/shared/types/entry-points";

// ---------------------------------------------------------------------------
// React hook dispatcher harness
// ---------------------------------------------------------------------------

interface HookDispatcher {
  useRef(initial: unknown): { current: unknown };
  useState(initial: unknown): [unknown, (next: unknown) => void];
  useCallback(cb: unknown, deps?: readonly unknown[]): unknown;
  useMemo(factory: () => unknown, deps?: readonly unknown[]): unknown;
  useEffect(fn: () => void, deps?: readonly unknown[]): void;
  useContext(ctx: unknown): unknown;
  useSyncExternalStore(subscribe: unknown, getSnapshot: () => unknown): unknown;
}

const currentReact = await import("react");
const reactInternals = (
  currentReact as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: HookDispatcher | null };
  }
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

// Transparent delegating mock — overrides any leaked global react hook mock.
// useContext / useSyncExternalStore (react-i18next) reach the slot unmocked.
mock.module("react", () => ({
  ...currentReact,
  useRef: (init: unknown) => reactInternals.H?.useRef(init),
  useState: (init: unknown) => reactInternals.H?.useState(init),
  useCallback: (cb: unknown, deps?: readonly unknown[]) => reactInternals.H?.useCallback(cb, deps),
  useMemo: (f: () => unknown, deps?: readonly unknown[]) => reactInternals.H?.useMemo(f, deps),
  useEffect: (fn: () => void, deps?: readonly unknown[]) => reactInternals.H?.useEffect(fn, deps),
}));

// ---------------------------------------------------------------------------
// IPC + toast stubs (real exports spread so later files keep the full surface)
// ---------------------------------------------------------------------------

type IpcHandler = (args: unknown) => Promise<unknown>;

const SESSION = { sessionId: "sess-1", initialPath: "/home/ada", user: "ada" };

const ipcCalls: Array<{ method: string; args: unknown }> = [];
let openBrowseSession: IpcHandler;
let saveProfile: IpcHandler;

const realIpcClient = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpcClient,
  ipcCallResult: (channel: string, method: string, args: unknown) => {
    ipcCalls.push({ method: `${channel}.${method}`, args });
    if (channel === "ssh" && method === "openBrowseSession") return openBrowseSession(args);
    if (channel === "connectionProfile" && method === "save") return saveProfile(args);
    return Promise.resolve(ipcOk(undefined));
  },
  ipcListen: () => () => {},
}));

const toastCalls: ToastInput[] = [];
const realToast = await import("../../../../../src/renderer/components/ui/toast");
mock.module("../../../../../src/renderer/components/ui/toast", () => ({
  ...realToast,
  showToast: (input: ToastInput) => {
    toastCalls.push(input);
  },
}));

const { SshNewConnectionView } = await import(
  "../../../../../src/renderer/components/workspace/add-workspace/ssh-new-connection-view"
);
const { ErrorNotice } = await import(
  "../../../../../src/renderer/components/workspace/add-workspace/error-notice"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seeds the host field with "ada@dev.example.com" so Connect is enabled. */
const PROFILE: ConnectionProfile = {
  id: "00000000-0000-4000-8000-000000000001",
  label: null,
  host: "dev.example.com",
  user: "ada",
  port: 22,
  identityFile: null,
  authMode: "interactive",
  favorite: false,
  lastUsedAt: 0,
  createdAt: 0,
};

type FormElement = ReactElement<{
  onSubmit: (event: { preventDefault(): void }) => void;
  children: unknown[];
}>;

/**
 * Mounts SshNewConnectionView under a minimal dispatcher. State setters store
 * the value for the next render(); effects run after every render (deps and
 * cleanups ignored), which is enough to report the phase via
 * onConnectPhaseChange.
 */
function mountView() {
  const refs: Array<{ current: unknown }> = [];
  const states: unknown[] = [];
  let effects: Array<() => void> = [];
  let refCursor = 0;
  let stateCursor = 0;
  const phases: string[] = [];
  const onConnected = mock((_session: SshBrowseSession) => {});

  const dispatcher: HookDispatcher = {
    useRef(initial) {
      const i = refCursor++;
      if (!(i in refs)) refs[i] = { current: initial };
      return refs[i];
    },
    useState(initial) {
      const i = stateCursor++;
      if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial;
      return [
        states[i],
        (next) => {
          states[i] = typeof next === "function" ? next(states[i]) : next;
        },
      ];
    },
    useCallback: (cb) => cb,
    useMemo: (factory) => factory(),
    useEffect(fn) {
      effects.push(fn);
    },
    useContext: () => undefined,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };

  function render(): FormElement {
    refCursor = 0;
    stateCursor = 0;
    effects = [];
    const previous = reactInternals.H;
    reactInternals.H = dispatcher;
    let element: FormElement;
    try {
      element = SshNewConnectionView({
        onConnected,
        configHosts: [],
        configHostsLoading: false,
        onConnectPhaseChange: (phase) => phases.push(phase),
        prefillProfile: PROFILE,
      }) as FormElement;
    } finally {
      reactInternals.H = previous;
    }
    for (const fn of effects) fn();
    return element;
  }

  return {
    render,
    onConnected,
    /** Submits the form from `form` (default: a fresh render). */
    submit: (form: FormElement = render()) => form.props.onSubmit({ preventDefault: () => {} }),
    /** Phase reported to the parent by the latest render. */
    phase: () => phases.at(-1),
    /** Message of the inline connection-error banner, or null when absent. */
    inlineError: (): string | null => {
      const notice = render().props.children.find(
        (child) => (child as ReactElement | null)?.type === ErrorNotice,
      ) as ReactElement<{ message: string }> | undefined;
      return notice?.props.message ?? null;
    },
  };
}

/** Drains the connect action's awaits before inspecting the view. */
async function settle(view: ReturnType<typeof mountView>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.render();
}

function callsTo(method: string): Array<{ method: string; args: unknown }> {
  return ipcCalls.filter((c) => c.method === method);
}

beforeEach(() => {
  ipcCalls.length = 0;
  toastCalls.length = 0;
  openBrowseSession = async () => ipcOk(SESSION);
  saveProfile = async () => ipcOk(undefined);
});

// ---------------------------------------------------------------------------
// Scenario tests
// ---------------------------------------------------------------------------

describe("SSH connect flow — happy path: connect ok + save ok", () => {
  it("calls onConnected once and saves the profile under the session's profile id", async () => {
    const view = mountView();

    view.submit();
    await settle(view);

    expect(view.onConnected).toHaveBeenCalledTimes(1);
    const session = view.onConnected.mock.calls[0]?.[0];
    expect(session).toMatchObject({
      sessionId: "sess-1",
      initialPath: "/home/ada",
      host: "dev.example.com",
      user: "ada",
    });
    expect(session?.connectionProfileId).toBe(session?.profileId);
    expect(callsTo("connectionProfile.save")).toHaveLength(1);
    expect(callsTo("connectionProfile.save")[0]?.args).toMatchObject({
      id: session?.profileId,
      host: "dev.example.com",
      user: "ada",
      authMode: "interactive",
    });
    expect(toastCalls).toHaveLength(0);
    expect(view.phase()).toBe("idle");
  });
});

describe("SSH connect flow — partial failure: connect ok, save fails", () => {
  beforeEach(() => {
    saveProfile = async () => ipcErr("not-found", "Profile store unavailable");
  });

  it("calls onConnected despite save failure and exits the connecting phase", async () => {
    const view = mountView();

    view.submit();
    await settle(view);

    // Primary flow must complete even though save failed.
    expect(view.onConnected).toHaveBeenCalledTimes(1);
    expect(view.phase()).toBe("idle");
    expect(view.inlineError()).toBeNull();
  });

  it("shows a save-failed action toast with a Retry save action", async () => {
    const view = mountView();

    view.submit();
    await settle(view);

    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0]).toMatchObject({
      kind: "error",
      message: "Connected. This connection couldn’t be saved for next time.",
    });
    expect(toastCalls[0]?.actions?.map((a) => a.label)).toEqual(["Retry save"]);
  });

  it("Retry save replays only the save and re-offers the toast when it fails again", async () => {
    const view = mountView();

    view.submit();
    await settle(view);
    toastCalls[0]?.actions?.[0]?.onAction();
    await settle(view);

    const saves = callsTo("connectionProfile.save");
    expect(callsTo("ssh.openBrowseSession")).toHaveLength(1);
    expect(saves).toHaveLength(2);
    expect(saves[1]?.args).toEqual(saves[0]?.args);
    expect(toastCalls).toHaveLength(2);
  });
});

describe("SSH connect flow — connection failure", () => {
  it("reports the error phase with the humanized message and skips the save", async () => {
    openBrowseSession = async () =>
      ipcErr("auth-failed", "SSH authentication failed", { code: "ssh.auth-failed" });
    const view = mountView();

    view.submit();
    await settle(view);

    expect(view.phase()).toBe("error");
    expect(view.inlineError()).toBe(
      "Authentication failed. Verify your credentials or identity file and try again.",
    );
    expect(view.onConnected).not.toHaveBeenCalled();
    expect(callsTo("connectionProfile.save")).toHaveLength(0);
    expect(toastCalls).toHaveLength(0);
  });
});

describe("SSH connect flow — auth cancellation", () => {
  it("returns to idle silently — no inline error, no onConnected, no toast", async () => {
    openBrowseSession = async () => ipcErr("cancelled", "User dismissed the auth prompt");
    const view = mountView();

    view.submit();
    await settle(view);

    expect(view.phase()).toBe("idle");
    expect(view.inlineError()).toBeNull();
    expect(view.onConnected).not.toHaveBeenCalled();
    expect(callsTo("connectionProfile.save")).toHaveLength(0);
    expect(toastCalls).toHaveLength(0);
  });
});

describe("SSH connect flow — stage-2 unexpected throw (freeze prevention)", () => {
  it("exits the connecting phase when the save rejects instead of returning IpcErrResult", async () => {
    saveProfile = async () => {
      throw new Error("save crashed unexpectedly");
    };
    const view = mountView();

    view.submit();
    await settle(view);

    // Not a cancellation, so the hook settles on error rather than staying loading.
    expect(view.phase()).toBe("error");
  });
});

describe("SSH connect flow — double-submit during in-flight connect", () => {
  it("opens a single browse session for repeated submits while connecting", async () => {
    let resolveOpen!: (result: unknown) => void;
    openBrowseSession = () =>
      new Promise((resolve) => {
        resolveOpen = resolve;
      });
    const view = mountView();

    // Double click before React re-renders, then once more from the re-rendered form.
    const form = view.render();
    view.submit(form);
    view.submit(form);
    view.render();
    expect(view.phase()).toBe("connecting");
    view.submit();

    expect(callsTo("ssh.openBrowseSession")).toHaveLength(1);

    resolveOpen(ipcOk(SESSION));
    await settle(view);

    expect(view.onConnected).toHaveBeenCalledTimes(1);
    expect(view.phase()).toBe("idle");
  });
});
