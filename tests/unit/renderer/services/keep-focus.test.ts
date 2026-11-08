/**
 * Keep-focus — the element that held the keyboard before a layout change
 * gets it back once its content is in the document again, unless something
 * else took it.
 */
import { describe, expect, it } from "bun:test";
import {
  type FocusDocument,
  type FocusHolder,
  focusHolder,
  restoreFocus,
} from "../../../../src/renderer/services/keep-focus";

const body = { name: "body" };

class FakeDocument implements FocusDocument {
  activeElement: unknown = body;
  readonly body = body;
}

class FakeElement implements FocusHolder {
  isConnected = true;
  inert = false;
  focused = 0;
  constructor(private readonly doc: FakeDocument) {}
  focus(): void {
    this.focused += 1;
    if (this.isConnected && !this.inert) this.doc.activeElement = this;
  }
  closest(selector: string): unknown {
    return selector === "[inert]" && this.inert ? this : null;
  }
}

function frameQueue() {
  const frames: Array<() => void> = [];
  return {
    nextFrame: (run: () => void) => frames.push(run),
    run(): void {
      for (const frame of frames.splice(0)) frame();
    },
    get pending(): number {
      return frames.length;
    },
  };
}

describe("focusHolder", () => {
  it("is null when the focus is on <body>", () => {
    const doc = new FakeDocument();
    expect(focusHolder(doc)).toBeNull();
  });

  it("is the focused element otherwise", () => {
    const doc = new FakeDocument();
    const terminal = new FakeElement(doc);
    doc.activeElement = terminal;
    expect(focusHolder(doc)).toBe(terminal);
  });
});

describe("restoreFocus", () => {
  it("focuses the element again once it is back in the document", () => {
    const doc = new FakeDocument();
    const frames = frameQueue();
    const terminal = new FakeElement(doc);
    // The split detached it: the focus fell to <body>.
    terminal.isConnected = false;
    restoreFocus(terminal, doc, 10, frames.nextFrame);

    frames.run();
    expect(doc.activeElement).toBe(body);
    terminal.isConnected = true;
    frames.run();
    expect(doc.activeElement).toBe(terminal);
  });

  it("catches a drop that comes after the request has settled", () => {
    const doc = new FakeDocument();
    const frames = frameQueue();
    const terminal = new FakeElement(doc);
    doc.activeElement = terminal;
    restoreFocus(terminal, doc, 10, frames.nextFrame);

    frames.run();
    expect(terminal.focused).toBe(0);
    // React renders the split a frame later.
    doc.activeElement = body;
    frames.run();
    expect(doc.activeElement).toBe(terminal);
  });

  it("leaves the focus to whatever else has taken it", () => {
    const doc = new FakeDocument();
    const frames = frameQueue();
    const terminal = new FakeElement(doc);
    const dialog = new FakeElement(doc);
    restoreFocus(terminal, doc, 10, frames.nextFrame);

    doc.activeElement = dialog;
    frames.run();
    expect(doc.activeElement).toBe(dialog);
    expect(terminal.focused).toBe(0);
    expect(frames.pending).toBe(0);
  });

  it("does not focus into a parked, inert view", () => {
    const doc = new FakeDocument();
    const frames = frameQueue();
    const terminal = new FakeElement(doc);
    terminal.inert = true;
    restoreFocus(terminal, doc, 10, frames.nextFrame);

    frames.run();
    expect(terminal.focused).toBe(0);
  });

  it("gives up after the frames it was given", () => {
    const doc = new FakeDocument();
    const frames = frameQueue();
    const terminal = new FakeElement(doc);
    terminal.isConnected = false;
    restoreFocus(terminal, doc, 3, frames.nextFrame);

    for (let i = 0; i < 5; i++) frames.run();
    expect(frames.pending).toBe(0);
    terminal.isConnected = true;
    frames.run();
    expect(doc.activeElement).toBe(body);
  });

  it("does nothing when nothing held the focus", () => {
    const frames = frameQueue();
    restoreFocus(null, new FakeDocument(), 10, frames.nextFrame);
    expect(frames.pending).toBe(0);
  });
});
