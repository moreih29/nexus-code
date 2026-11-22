import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { setImmediate as flush } from "node:timers/promises";
import type { PushSend, ServerInfo } from "../../../../../packages/remote-protocol/src";
import type { CliServices, PendingConsent } from "../../../../../src/main/features/cli/context";
import { MAX_REMOTE_BODY_CHARS } from "../../../../../src/main/features/remote/consents";
import { ServerError, UnreachableError } from "../../../../../src/main/features/remote/errors";
import { PhonePush } from "../../../../../src/main/features/remote/phone-push";
import { servesWith } from "../../../../../src/main/features/remote/serving/common";
import type { CliChange, CliChatWaiting } from "../../../../../src/shared/cli/ui";
import type { PhonePushPolicy } from "../../../../../src/shared/types/app-state";
import { withSessionsSnapshot } from "../../../../helpers/sessions-snapshot";

const info = { signIn: ["google"], relay: null, voice: null };
const phone = { id: "iphone", name: "iPhone", platform: "ios" };
const android = { id: "android-phone", name: "Pixel", platform: "android" };
const computer = { id: "desktop", name: "My desktop", platform: "darwin" };
const pushInfo = { ...info, push: { version: 1, environments: ["production"] } };
const consentChange = { kind: "chatInput", detail: "Please edit /private/project" } as const;
const logResponse = { sent: 1, skipped: 0 };
let push: PhonePush | undefined;
let now: number;

beforeEach(() => {
  jest.useFakeTimers();
  now = 0;
});

afterEach(() => {
  push?.dispose();
  push = undefined;
  jest.useRealTimers();
});

async function tick(ms = 0): Promise<void> {
  await flush();
  while (ms > 0) {
    const step = Math.min(1_000, ms);
    now += step;
    jest.advanceTimersByTime(step);
    await flush();
    ms -= step;
  }
}

function setup(
  options: {
    serverInfo?: ServerInfo;
    devices?: (typeof phone)[];
    mode?: PhonePushPolicy;
    signedOut?: boolean;
    /** The renderer tells its sessions' changes (cli.sessionsChanged). */
    revisions?: boolean;
  } = {},
) {
  let token = options.signedOut ? undefined : "token";
  let policy = options.mode ?? "always";
  let away = false;
  let screenLockChanged: (() => void) | undefined;
  let chatWait: { id: string; kind: CliChatWaiting["kind"] } | undefined;
  let chatReadable = true;
  let terminalWait: string | undefined;
  const controls = { chat: true, terminal: false };
  const consents: PendingConsent[] = [];
  const send = mock(async (_body: PushSend, _signal: AbortSignal) => logResponse as unknown);
  const devices = mock(async () => options.devices ?? [phone]);
  const serverInfo = mock(async () => options.serverInfo ?? pushInfo);
  const ui = mock(async (op: string, args: { includeWaitingId?: boolean }) => {
    if (op === "sessions.results") return { unread: {} };
    if (op === "tabs.list") {
      return {
        tabs: [
          { id: "chat", title: "Private title", type: "codex" },
          { id: "terminal", title: "Private terminal", type: "terminal" },
        ],
      };
    }
    if (!chatReadable) throw new Error("window did not answer");
    return chatWait
      ? {
          agent: "codex",
          state: "asking",
          waiting: { kind: chatWait.kind, text: "Private prompt" },
          ...(args.includeWaitingId ? { waitingId: chatWait.id } : {}),
        }
      : { agent: "codex", state: "idle" };
  });
  let revision = 1;
  let latest: number | undefined;
  const revisions = {
    latest: () => latest,
    saw: (seen: number) => {
      if (latest === undefined || seen > latest) latest = seen;
    },
  };
  let snapshots = 0;
  const snapshot = withSessionsSnapshot(ui, () => revision);
  const services = {
    listWorkspaces: () => [{ id: "w", name: "Private workspace", rootPath: "/private/project" }],
    ui: (op: string, args: never) => {
      if (op === "sessions.snapshot") snapshots++;
      return snapshot(op, args);
    },
    ...(options.revisions ? { sessionsRevision: revisions } : {}),
    consents: { list: () => consents },
    activity: () => null,
    claudeStatus: () => (terminalWait ? { status: "permissionPending", since: 0 } : null),
    claudeAsks: () =>
      terminalWait ? [{ id: terminalWait, tool: "Bash", always: [], since: 0 }] : [],
    claudeAgents: { list: () => [] },
  } as unknown as CliServices;
  const enabledChanged = mock(() => {});
  const stopScreenLockListener = mock(() => {
    screenLockChanged = undefined;
  });
  const sender = new PhonePush({
    account: { token: () => token, info: serverInfo, devices, sendPush: send },
    services: () => services,
    controls: () => controls,
    policy: () => policy,
    activity: {
      away: () => away,
      onScreenLockChanged: (listener) => {
        screenLockChanged = listener;
        return stopScreenLockListener;
      },
    },
    now: () => now,
    onEnabledChanged: enabledChanged,
  });
  push = sender;
  sender.accountChanged();
  return {
    sender,
    send,
    devices,
    serverInfo,
    enabledChanged,
    ui,
    controls,
    setAway: (yes: boolean) => {
      away = yes;
    },
    screenLockChanged: () => screenLockChanged?.(),
    stopScreenLockListener,
    setPolicy: (mode: PhonePushPolicy) => {
      policy = mode;
      sender.policyChanged();
    },
    signOut: () => {
      token = undefined;
      sender.accountChanged();
    },
    chat: (id?: string, kind: CliChatWaiting["kind"] = "question") => {
      chatWait = id ? { id, kind } : undefined;
    },
    chatReadable: (value: boolean) => {
      chatReadable = value;
    },
    snapshots: () => snapshots,
    /** The renderer's sessions changed, and it told main. */
    changed: () => {
      revision++;
      revisions.saw(revision);
    },
    terminal: (id?: string) => {
      terminalWait = id;
    },
    consent: (timeoutMs = 90_000, change: CliChange = consentChange) => {
      const at = now;
      const id = `consent-${at}-${consents.length}`;
      consents.push({
        id,
        at,
        expiresAt: at + timeoutMs,
        request: { fromWorkspaceId: "w", fromTabId: "t", toWorkspaceId: "w2", change, timeoutMs },
      });
      sender.consentsChanged();
      return () => {
        const index = consents.findIndex((event) => event.id === id);
        consents.splice(index, 1);
        sender.consentsChanged();
      };
    },
  };
}

describe("phone push discovery", () => {
  test.each([
    ["signed out", { signedOut: true }],
    ["server without push", { serverInfo: info }],
    ["different version", { serverInfo: { ...info, push: { version: 2, environments: [] } } }],
    ["no phone", { devices: [computer, { id: "web", name: "Browser", platform: "web" }] }],
    ["off", { mode: "off" as const }],
  ] as const)("stays off with %s", async (_label, options) => {
    const app = setup({
      ...options,
      ...("devices" in options ? { devices: [...options.devices] } : {}),
    });
    await tick();
    app.consent();
    app.chat("question");
    await tick(30_000);
    expect(app.sender.enabled()).toBe(false);
    expect(servesWith(true, true, true, app.sender.enabled())).not.toContain("push");
    expect(app.send).not.toHaveBeenCalled();
    expect(app.ui).not.toHaveBeenCalled();
  });

  test("advertises push with offline phones and withdraws it when switched off or signed out", async () => {
    const app = setup({ devices: [] });
    const peers = [{ ...phone, online: false }, { ...android, online: true }, computer];
    app.sender.presence(peers);
    await tick();
    expect(app.devices).not.toHaveBeenCalled();
    expect(servesWith(true, false, false, app.sender.enabled())).toContain("push");
    expect(servesWith(true, true, true)).not.toContain("push");
    app.setAway(true);
    app.consent();
    expect(app.send.mock.calls[0]?.[0].to).toEqual([phone.id, android.id]);
    app.setPolicy("off");
    expect(app.sender.enabled()).toBe(false);
    app.setPolicy("away");
    expect(app.sender.enabled()).toBe(true);
    app.signOut();
    expect(app.sender.enabled()).toBe(false);
    expect(app.enabledChanged).toHaveBeenCalledTimes(4);
  });
});

describe("consent notifications", () => {
  test("sends immediately when away and only tells the server the envelope", async () => {
    const app = setup({ devices: [phone, android, computer] });
    await tick();
    app.setAway(true);
    app.consent();
    expect(app.send.mock.calls[0]?.[0]).toEqual({
      id: expect.stringMatching(/^[\w-]{22}$/),
      kind: "consent",
      ttl: 88,
      to: [phone.id, android.id],
    });
  });

  test("always waits ten seconds for a present user, and cancels a resolved consent", async () => {
    const app = setup();
    await tick();
    const resolve = app.consent();
    await tick(9_999);
    expect(app.send).not.toHaveBeenCalled();
    resolve();
    await tick(1);
    expect(app.send).not.toHaveBeenCalled();
    app.consent();
    await tick(10_000);
    expect(app.send).toHaveBeenCalledTimes(1);
    expect(app.send.mock.calls[0]?.[0].ttl).toBe(78);
  });

  test("the default rechecks idle time after grace until the consent expires", async () => {
    const app = setup({ mode: "away" });
    await tick();
    app.consent(15_000);
    await tick(13_000);
    expect(app.send).not.toHaveBeenCalled();
    app.setAway(true);
    app.screenLockChanged();
    expect(app.send).not.toHaveBeenCalled();
    app.setAway(false);
    app.consent();
    await tick(10_000);
    expect(app.send).not.toHaveBeenCalled();
    app.setAway(true);
    await tick(3_000);
    expect(app.send).toHaveBeenCalledTimes(1);
    expect(app.send.mock.calls[0]?.[0].ttl).toBe(75);
  });

  test("screen lock rechecks a consent after grace and shutdown removes the listener", async () => {
    const app = setup({ mode: "away" });
    await tick();
    app.consent();
    await tick(10_000);
    expect(app.send).not.toHaveBeenCalled();
    app.setAway(true);
    app.screenLockChanged();
    expect(app.send).toHaveBeenCalledTimes(1);
    app.sender.dispose();
    app.sender.dispose();
    expect(app.stopScreenLockListener).toHaveBeenCalledTimes(1);
  });

  test("skips under five seconds of delivery TTL and accepts exactly five", async () => {
    const app = setup();
    await tick();
    app.setAway(true);
    app.consent(6_999);
    expect(app.send).not.toHaveBeenCalled();
    app.consent(7_000);
    expect(app.send.mock.calls[0]?.[0].ttl).toBe(5);
  });

  test("uses the same refusals as consent.answer", async () => {
    const app = setup();
    await tick();
    app.setAway(true);
    app.consent(90_000, { ...consentChange, body: "x".repeat(MAX_REMOTE_BODY_CHARS + 1) });
    app.consent(90_000, { kind: "terminalInput", detail: "Type" });
    app.controls.chat = false;
    app.consent();
    expect(app.send).not.toHaveBeenCalled();
    app.controls.chat = true;
    app.sender.controlsChanged();
    expect(app.send).toHaveBeenCalledTimes(1);
    app.controls.terminal = true;
    app.sender.controlsChanged();
    expect(app.send).toHaveBeenCalledTimes(2);
  });

  test("retries a network failure just once with the same ID and the remaining TTL", async () => {
    const app = setup();
    await tick();
    app.setAway(true);
    let fail: ((error: Error) => void) | undefined;
    app.send.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    app.send.mockRejectedValueOnce(new UnreachableError("still offline"));
    app.consent();
    await tick(3_000);
    fail?.(new UnreachableError("offline"));
    await tick();
    const [first, retry] = app.send.mock.calls.map(([body]) => body);
    expect(first).toMatchObject({ kind: "consent", ttl: 88 });
    expect(retry).toEqual({ ...first, ttl: 85 });
    await tick(10_000);
    expect(app.send).toHaveBeenCalledTimes(2);
  });

  test("does not retry after the prompt resolves or loses enough TTL", async () => {
    const app = setup();
    await tick();
    app.setAway(true);
    let fail: ((error: Error) => void) | undefined;
    app.send.mockImplementation(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    app.consent(8_000);
    await tick(2_000);
    fail?.(new UnreachableError("offline"));
    await tick();
    expect(app.send).toHaveBeenCalledTimes(1);
    const resolve = app.consent();
    resolve();
    expect(app.send.mock.calls[1]?.[1].aborted).toBe(true);
    fail?.(new UnreachableError("offline again"));
    await tick();
    expect(app.send).toHaveBeenCalledTimes(2);
  });

  test("a duplicate response completes the existing event", async () => {
    const app = setup();
    await tick();
    app.setAway(true);
    app.send.mockRejectedValueOnce(new UnreachableError("the response was lost"));
    app.send.mockResolvedValueOnce({ duplicate: true });
    app.consent();
    await tick(30_000);
    expect(app.send).toHaveBeenCalledTimes(2);
    expect(app.send.mock.calls[1]?.[0].id).toBe(app.send.mock.calls[0]?.[0].id);
  });

  test.each([
    [400, "bad_request"],
    [403, "not_a_computer"],
    [429, "rate_limited"],
    [503, "push_unavailable"],
  ])("consumes the event on HTTP %i", async (status, code) => {
    const app = setup();
    await tick();
    app.setAway(true);
    app.send.mockRejectedValueOnce(new ServerError(status, code, "push"));
    app.consent();
    await tick(40_000);
    expect(app.send).toHaveBeenCalledTimes(1);
  });
});

describe("chat and terminal request notifications", () => {
  test.each([
    "permission",
    "question",
    "plan",
  ] as const)("gives a chat %s twenty seconds and sends only once per request", async (kind) => {
    const app = setup();
    app.chat("same request", kind);
    await tick(19_999);
    expect(app.send).not.toHaveBeenCalled();
    await tick(1);
    expect(app.send.mock.calls[0]?.[0]).toEqual({
      id: expect.stringMatching(/^[\w-]{22}$/),
      kind: "request",
      ttl: 600,
      to: [phone.id],
    });
    app.setPolicy("off");
    app.setPolicy("always");
    await tick(30_000);
    expect(app.send).toHaveBeenCalledTimes(1);
    app.chat("different request", kind);
    await tick(23_000);
    expect(app.send).toHaveBeenCalledTimes(2);
    expect(app.send.mock.calls[0]?.[0].id).not.toBe(app.send.mock.calls[1]?.[0].id);
  });

  test("notifies for a terminal ask only with the control required by terminal.answer", async () => {
    const app = setup();
    app.controls.chat = false;
    app.controls.terminal = true;
    app.terminal("terminal-hook-id");
    await tick(25_000);
    expect(app.send).not.toHaveBeenCalled();
    app.controls.chat = true;
    app.controls.terminal = false;
    app.sender.controlsChanged();
    await tick(20_000);
    expect(app.send.mock.calls[0]?.[0]).toMatchObject({ kind: "request", ttl: 600 });
  });

  test("waits for away after the grace and never sends an answered or expired request", async () => {
    const app = setup({ mode: "away" });
    app.chat("resolved");
    app.terminal("still waiting");
    await tick(19_000);
    app.chat();
    await tick(6_000);
    expect(app.send).not.toHaveBeenCalled();
    app.setAway(true);
    await tick(3_000);
    expect(app.send).toHaveBeenCalledTimes(1);
    app.setAway(false);
    app.chat("expires");
    await tick(610_000);
    app.setAway(true);
    await tick(3_000);
    expect(app.send).toHaveBeenCalledTimes(1);
  });

  test("an incomplete read does not confirm a waiting request or reset its ID", async () => {
    const app = setup();
    app.chat("still waiting");
    await tick(19_000);
    app.chatReadable(false);
    await tick(5_000);
    expect(app.send).not.toHaveBeenCalled();
    app.chatReadable(true);
    await tick(3_000);
    expect(app.send).toHaveBeenCalledTimes(1);
    app.chatReadable(false);
    await tick(3_000);
    app.chatReadable(true);
    await tick(30_000);
    expect(app.send).toHaveBeenCalledTimes(1);
  });

  test("reads the sessions again only when the renderer tells a change, and every ten seconds", async () => {
    const app = setup({ revisions: true });
    await tick();
    const first = app.snapshots();
    expect(first).toBe(1);
    // Checked every 3 seconds: the read stands until it is 10 seconds old.
    await tick(9_000);
    expect(app.snapshots()).toBe(first);
    await tick(3_000);
    expect(app.snapshots()).toBe(first + 1);
    app.chat("new request");
    app.changed();
    await tick(3_000);
    expect(app.snapshots()).toBe(first + 2);
    await tick(20_000);
    expect(app.send).toHaveBeenCalledTimes(1);
  });

  test("rechecks the pending request before its network retry", async () => {
    const app = setup();
    let fail: ((error: Error) => void) | undefined;
    app.send.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    app.chat("about to be answered");
    await tick(20_000);
    app.chat();
    fail?.(new UnreachableError("offline"));
    await tick(3_000);
    expect(app.send).toHaveBeenCalledTimes(1);
  });
});
