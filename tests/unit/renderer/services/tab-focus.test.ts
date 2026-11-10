/**
 * A tab's focus lands on the next frame, or once its view registers, unless
 * something came after it: a newer request, a tab's name starting to be
 * edited, or — for one that waited — the user going into a text field. A
 * view that must put the focus off itself (a terminal not open yet) is
 * handed the same test. bun:test runs without a DOM, so the document is a
 * stand-in that only tells what has the focus, and frames run when a test
 * says so.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  cancelTabFocus,
  focusStillWanted,
  registerTabFocusTarget,
  requestTabFocus,
} from "../../../../src/renderer/services/tab-focus";
import { useTabEditingStore } from "../../../../src/renderer/state/stores/tab-editing";

type Fake = { tagName: string; type?: string; isContentEditable?: boolean };

const body: Fake = { tagName: "BODY" };
const doc = { activeElement: body as Fake | null, body };
const g = globalThis as Record<string, unknown>;
const saved = { document: g.document, requestAnimationFrame: g.requestAnimationFrame };
let frames: (() => void)[] = [];

beforeAll(() => {
  g.document = doc;
  g.requestAnimationFrame = (callback: (time: number) => void) => {
    frames.push(() => callback(0));
    return frames.length;
  };
});

afterAll(() => {
  g.document = saved.document;
  g.requestAnimationFrame = saved.requestAnimationFrame;
});

beforeEach(() => {
  frames = [];
  doc.activeElement = body;
});

function nextFrame(): void {
  const run = frames;
  frames = [];
  for (const frame of run) frame();
}

function focus(el: Fake): Fake {
  doc.activeElement = el;
  return el;
}

const button = (): Fake => ({ tagName: "BUTTON" });
const input = (type = "text"): Fake => ({ tagName: "INPUT", type });
const textarea = (): Fake => ({ tagName: "TEXTAREA" });

let seq = 0;

/** A tab's view, counting the focuses it gets and keeping the last test it was handed. */
function view() {
  const tabId = `tab-${++seq}`;
  let focused = 0;
  let wanted: (() => boolean) | null = null;
  return {
    tabId,
    focused: () => focused,
    wanted: () => wanted?.() ?? null,
    register: () =>
      registerTabFocusTarget(tabId, (test) => {
        focused += 1;
        wanted = test;
      }),
  };
}

describe("a tab's view that is there", () => {
  test("is focused on the next frame", () => {
    const tab = view();
    tab.register();
    focus(button());
    requestTabFocus(tab.tabId);
    expect(tab.focused()).toBe(0);
    nextFrame();
    expect(tab.focused()).toBe(1);
  });

  test("is not, when its name starts to be edited before that frame", () => {
    // The first click of a double-click asks; the second starts the rename.
    const tab = view();
    tab.register();
    focus(button());
    requestTabFocus(tab.tabId);
    cancelTabFocus();
    focus(input());
    nextFrame();
    expect(tab.focused()).toBe(0);
  });

  test("is not, when another tab was asked for since", () => {
    const first = view();
    const second = view();
    first.register();
    second.register();
    requestTabFocus(first.tabId);
    requestTabFocus(second.tabId);
    nextFrame();
    expect(first.focused()).toBe(0);
    expect(second.focused()).toBe(1);
  });

  test("hands its view a test that typing elsewhere turns off", () => {
    // A terminal not open yet keeps the test, for when it opens.
    const tab = view();
    tab.register();
    focus(button());
    requestTabFocus(tab.tabId);
    nextFrame();
    expect(tab.wanted()).toBe(true);
    focus(input());
    expect(tab.wanted()).toBe(false);
  });

  test("hands it a test a rename turns off", () => {
    const tab = view();
    tab.register();
    requestTabFocus(tab.tabId);
    nextFrame();
    cancelTabFocus();
    expect(tab.wanted()).toBe(false);
  });
});

describe("starting to edit a tab's name", () => {
  test("drops the focus the click before it asked for", () => {
    const tab = view();
    tab.register();
    requestTabFocus(tab.tabId);
    useTabEditingStore.getState().startEditing(tab.tabId);
    nextFrame();
    expect(tab.focused()).toBe(0);
    useTabEditingStore.getState().cancelEditing();
  });
});

describe("a focus asked for before the tab's view registers", () => {
  test("is applied once it does", () => {
    const tab = view();
    focus(button());
    requestTabFocus(tab.tabId);
    tab.register();
    nextFrame();
    expect(tab.focused()).toBe(1);
  });

  test("is dropped once the user is typing in a text field", () => {
    const tab = view();
    focus(button());
    requestTabFocus(tab.tabId);
    // A tab's name being edited.
    focus(input());
    tab.register();
    nextFrame();
    expect(tab.focused()).toBe(0);
  });

  test("is dropped by a rename started meanwhile", () => {
    const tab = view();
    requestTabFocus(tab.tabId);
    cancelTabFocus();
    tab.register();
    nextFrame();
    expect(tab.focused()).toBe(0);
  });

  test("is applied when the focus moved to another control", () => {
    const tab = view();
    focus(input());
    requestTabFocus(tab.tabId);
    // A menu handing the focus back to its trigger.
    focus(button());
    tab.register();
    nextFrame();
    expect(tab.focused()).toBe(1);
  });

  test("is applied when the text field had the focus as it was asked for", () => {
    const tab = view();
    // A keyboard shortcut pressed in another terminal.
    focus(textarea());
    requestTabFocus(tab.tabId);
    tab.register();
    nextFrame();
    expect(tab.focused()).toBe(1);
  });
});

describe("focusStillWanted", () => {
  test("a text field focused since stops it; a control or the page does not", () => {
    const from = focus(button()) as unknown as Element;
    expect(focusStillWanted(from)).toBe(true);
    focus(textarea());
    expect(focusStillWanted(from)).toBe(false);
    focus(input("search"));
    expect(focusStillWanted(from)).toBe(false);
    focus({ tagName: "DIV", isContentEditable: true });
    expect(focusStillWanted(from)).toBe(false);
    focus(input("checkbox"));
    expect(focusStillWanted(from)).toBe(true);
    focus(body);
    expect(focusStillWanted(from)).toBe(true);
  });
});
