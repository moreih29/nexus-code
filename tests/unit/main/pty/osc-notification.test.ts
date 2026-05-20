import { describe, expect, mock, test } from "bun:test";
import {
  OscNotificationDispatcher,
  extractOscNotifications,
} from "../../../../src/main/features/pty/osc-notification";

// ---------------------------------------------------------------------------
// extractOscNotifications — pure parser
// ---------------------------------------------------------------------------

describe("extractOscNotifications", () => {
  test("empty string → empty array", () => {
    expect(extractOscNotifications("")).toEqual([]);
  });

  test("plain text without OSC → empty array", () => {
    expect(extractOscNotifications("hello world\r\nsome output")).toEqual([]);
  });

  test("OSC 9 single match", () => {
    const chunk = "\x1b]9;Task finished\x07";
    expect(extractOscNotifications(chunk)).toEqual([
      { kind: "osc9", body: "Task finished" },
    ]);
  });

  test("OSC 9 with ST terminator", () => {
    const chunk = "\x1b]9;Done\x1b\\";
    expect(extractOscNotifications(chunk)).toEqual([{ kind: "osc9", body: "Done" }]);
  });

  test("OSC 777 single match", () => {
    const chunk = "\x1b]777;notify;Build complete;All tests passed\x07";
    expect(extractOscNotifications(chunk)).toEqual([
      { kind: "osc777", title: "Build complete", body: "All tests passed" },
    ]);
  });

  test("OSC 99 single match — no title param", () => {
    const chunk = "\x1b]99;;Task done\x07";
    expect(extractOscNotifications(chunk)).toEqual([
      { kind: "osc99", body: "Task done" },
    ]);
  });

  test("OSC 99 with p=title param", () => {
    const chunk = "\x1b]99;p=title:My Title;Body text\x07";
    expect(extractOscNotifications(chunk)).toEqual([
      { kind: "osc99", title: "My Title", body: "Body text" },
    ]);
  });

  test("mixed OSC 9 + OSC 777 in one chunk", () => {
    const chunk =
      "some output\x1b]9;First\x07more text\x1b]777;notify;Title;Second\x07end";
    const results = extractOscNotifications(chunk);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ kind: "osc9", body: "First" });
    expect(results[1]).toEqual({ kind: "osc777", title: "Title", body: "Second" });
  });

  test("OSC 9 title field is undefined", () => {
    const chunk = "\x1b]9;body only\x07";
    const [n] = extractOscNotifications(chunk);
    expect(n.title).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// OscNotificationDispatcher
// ---------------------------------------------------------------------------

/** Minimal BrowserWindow-shaped stub. */
function makeFakeWindow(minimized = false) {
  return { isMinimized: () => minimized };
}

/** Creates a mock Notification constructor and returns it with trackers. */
function makeNotificationCtor() {
  const showSpy = mock(() => {});
  const instances: { title: string; body: string }[] = [];
  let ctorCallCount = 0;
  // Stores the registered click handler so tests can trigger it.
  let clickHandler: (() => void) | null = null;

  class FakeNotification {
    constructor(opts: { title: string; body: string }) {
      ctorCallCount += 1;
      instances.push(opts);
    }
    show = showSpy;
    on(event: string, cb: () => void) {
      if (event === "click") clickHandler = cb;
    }
  }

  const Ctor = FakeNotification as unknown as typeof import("electron").Notification;

  return {
    Ctor,
    showSpy,
    instances,
    /** Returns the number of times the constructor was invoked. */
    ctorCallCount: () => ctorCallCount,
    /** Fires the most recently registered click handler. */
    triggerClick: () => clickHandler?.(),
  };
}

const WORKSPACE_ID = "ws-1";
const TAB_ID = "tab-1";

describe("OscNotificationDispatcher", () => {
  test("focused window — Notification ctor not called", () => {
    const { Ctor, showSpy, ctorCallCount } = makeNotificationCtor();
    const dispatcher = new OscNotificationDispatcher({
      workspaceManager: { getName: () => "My Workspace" },
      getFocusedWindow: () => makeFakeWindow(false) as never,
      electronNotificationCtor: Ctor,
      broadcastFn: mock(() => {}),
    });

    dispatcher.handleChunk(WORKSPACE_ID, TAB_ID, "\x1b]9;Done\x07");

    expect(ctorCallCount()).toBe(0);
    expect(showSpy).not.toHaveBeenCalled();
  });

  test("minimized window counts as background — Notification ctor called", () => {
    const { Ctor, showSpy, instances, ctorCallCount } = makeNotificationCtor();
    const dispatcher = new OscNotificationDispatcher({
      workspaceManager: { getName: () => "My Workspace" },
      getFocusedWindow: () => makeFakeWindow(true) as never,
      electronNotificationCtor: Ctor,
      broadcastFn: mock(() => {}),
    });

    dispatcher.handleChunk(WORKSPACE_ID, TAB_ID, "\x1b]9;Done\x07");

    expect(ctorCallCount()).toBe(1);
    expect(showSpy).toHaveBeenCalledTimes(1);
    expect(instances[0].title).toContain("[My Workspace]");
    expect(instances[0].body).toBe("Done");
  });

  test("no focused window — Notification ctor called once", () => {
    const { Ctor, instances, ctorCallCount } = makeNotificationCtor();
    const dispatcher = new OscNotificationDispatcher({
      workspaceManager: { getName: () => "Project X" },
      getFocusedWindow: () => null,
      electronNotificationCtor: Ctor,
      broadcastFn: mock(() => {}),
    });

    dispatcher.handleChunk(WORKSPACE_ID, TAB_ID, "\x1b]777;notify;Build;Tests passed\x07");

    expect(ctorCallCount()).toBe(1);
    expect(instances[0].title).toBe("[Project X] Build");
    expect(instances[0].body).toBe("Tests passed");
  });

  test("workspace name lookup failure → fallback 'Terminal'", () => {
    const { Ctor, instances } = makeNotificationCtor();
    const dispatcher = new OscNotificationDispatcher({
      workspaceManager: { getName: () => null },
      getFocusedWindow: () => null,
      electronNotificationCtor: Ctor,
      broadcastFn: mock(() => {}),
    });

    dispatcher.handleChunk(WORKSPACE_ID, TAB_ID, "\x1b]9;alert\x07");

    expect(instances[0].title).toContain("[Terminal]");
  });

  test("chunk without OSC sequences — no notification fired", () => {
    const { ctorCallCount } = makeNotificationCtor();
    const dispatcher = new OscNotificationDispatcher({
      workspaceManager: { getName: () => "WS" },
      getFocusedWindow: () => null,
      electronNotificationCtor: makeNotificationCtor().Ctor,
      broadcastFn: mock(() => {}),
    });

    dispatcher.handleChunk(WORKSPACE_ID, TAB_ID, "just normal terminal output\r\n");

    expect(ctorCallCount()).toBe(0);
  });

  test("click: activateWorkspace called with workspaceId", () => {
    const { Ctor, triggerClick } = makeNotificationCtor();
    const activateWorkspace = mock((_id: string) => Promise.resolve());
    const dispatcher = new OscNotificationDispatcher({
      workspaceManager: { getName: () => "WS" },
      getFocusedWindow: () => null,
      electronNotificationCtor: Ctor,
      activateWorkspace,
      broadcastFn: mock(() => {}),
    });

    dispatcher.handleChunk(WORKSPACE_ID, TAB_ID, "\x1b]9;Done\x07");
    triggerClick();

    expect(activateWorkspace).toHaveBeenCalledTimes(1);
    expect(activateWorkspace).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  test("click: focusMainWindow called", () => {
    const { Ctor, triggerClick } = makeNotificationCtor();
    const focusMainWindow = mock(() => {});
    const dispatcher = new OscNotificationDispatcher({
      workspaceManager: { getName: () => "WS" },
      getFocusedWindow: () => null,
      electronNotificationCtor: Ctor,
      focusMainWindow,
      broadcastFn: mock(() => {}),
    });

    dispatcher.handleChunk(WORKSPACE_ID, TAB_ID, "\x1b]9;Done\x07");
    triggerClick();

    expect(focusMainWindow).toHaveBeenCalledTimes(1);
  });

  test("click: broadcast called with workspaceId and tabId", () => {
    const { Ctor, triggerClick } = makeNotificationCtor();
    const broadcastFn = mock((_ch: string, _ev: string, _args: unknown) => {});
    const dispatcher = new OscNotificationDispatcher({
      workspaceManager: { getName: () => "WS" },
      getFocusedWindow: () => null,
      electronNotificationCtor: Ctor,
      broadcastFn,
    });

    dispatcher.handleChunk(WORKSPACE_ID, TAB_ID, "\x1b]9;Done\x07");
    triggerClick();

    expect(broadcastFn).toHaveBeenCalledWith("pty", "notificationClick", {
      workspaceId: WORKSPACE_ID,
      tabId: TAB_ID,
    });
  });
});
