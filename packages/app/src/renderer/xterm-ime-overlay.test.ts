import { describe, expect, test } from "bun:test";

import {
  XTERM_IME_PATCH_CSS,
  XTERM_IME_PATCH_ROOT_CLASS,
  XTERM_IME_STYLE_ELEMENT_ID,
  XtermCompositionBuffer,
  XtermImeOverlay,
  ensureXtermImePatchStyle,
  handleEnterDuringComposition,
  shouldSwallowEnterDuringComposition,
  toXtermImeOverlayTransform,
  type OverlayHostLike,
  type OverlayNodeLike,
  type StyleDocumentLike,
  type StyleNodeLike,
} from "./xterm-ime-overlay";

class FakeClassList {
  private readonly tokens = new Set<string>();

  public add(token: string): void {
    this.tokens.add(token);
  }

  public remove(token: string): void {
    this.tokens.delete(token);
  }

  public has(token: string): boolean {
    return this.tokens.has(token);
  }
}

class FakeNode implements OverlayNodeLike {
  public id = "";
  public className = "";
  public textContent: string | null = "";
  public style: NonNullable<OverlayNodeLike["style"]> = {};
  public children: FakeNode[] = [];

  public appendChild(node: unknown): void {
    this.children.push(node as FakeNode);
  }

  public removeChild(node: unknown): void {
    const index = this.children.indexOf(node as FakeNode);
    if (index >= 0) {
      this.children.splice(index, 1);
    }
  }
}

class FakeDocument implements StyleDocumentLike {
  public readonly head = new FakeNode();

  public getElementById(id: string): unknown {
    return this.head.children.find((node) => node.id === id) ?? null;
  }

  public createElement(_tagName: string): StyleNodeLike {
    return new FakeNode();
  }
}

describe("xterm-ime-overlay", () => {
  test("swallows Enter only while composing", () => {
    const composingEnterEvent = {
      key: "Enter",
      isComposing: true,
      preventDefaultCount: 0,
      stopPropagationCount: 0,
      preventDefault() {
        this.preventDefaultCount += 1;
      },
      stopPropagation() {
        this.stopPropagationCount += 1;
      },
    };
    expect(shouldSwallowEnterDuringComposition(composingEnterEvent)).toBeTrue();
    expect(handleEnterDuringComposition(composingEnterEvent)).toBeTrue();
    expect(composingEnterEvent.preventDefaultCount).toBe(1);
    expect(composingEnterEvent.stopPropagationCount).toBe(1);

    const plainEnterEvent = {
      key: "Enter",
      isComposing: false,
      preventDefaultCount: 0,
      stopPropagationCount: 0,
      preventDefault() {
        this.preventDefaultCount += 1;
      },
      stopPropagation() {
        this.stopPropagationCount += 1;
      },
    };
    expect(shouldSwallowEnterDuringComposition(plainEnterEvent)).toBeFalse();
    expect(handleEnterDuringComposition(plainEnterEvent)).toBeFalse();
    expect(plainEnterEvent.preventDefaultCount).toBe(0);
    expect(plainEnterEvent.stopPropagationCount).toBe(0);
  });

  test("composition buffer flushes once on compositionend", () => {
    const buffer = new XtermCompositionBuffer();
    buffer.start();
    buffer.update("ㅎ");
    buffer.update("하");
    buffer.update("한");

    expect(buffer.end("")).toBe("한");
    expect(buffer.end("한")).toBeNull();

    expect(buffer.shouldForwardTerminalData("한")).toBeFalse();
    expect(buffer.shouldForwardTerminalData("\r")).toBeTrue();

    buffer.start();
    buffer.update("글");
    expect(buffer.end("글")).toBe("글");
  });

  test("injects targeted CSS patch only once", () => {
    const fakeDocument = new FakeDocument();

    ensureXtermImePatchStyle(fakeDocument);
    ensureXtermImePatchStyle(fakeDocument);

    expect(fakeDocument.head.children).toHaveLength(1);
    expect(fakeDocument.head.children[0]?.id).toBe(XTERM_IME_STYLE_ELEMENT_ID);
    expect(fakeDocument.head.children[0]?.textContent).toBe(XTERM_IME_PATCH_CSS);
    expect(XTERM_IME_PATCH_CSS.includes(`.${XTERM_IME_PATCH_ROOT_CLASS} .composition-view`)).toBeTrue();
  });

  test("renders app-owned overlay at supplied cursor seam coordinates", () => {
    const fakeDocument = new FakeDocument();
    const hostNode = new FakeNode() as OverlayHostLike & FakeNode;
    hostNode.ownerDocument = fakeDocument;
    hostNode.classList = new FakeClassList();

    const overlay = new XtermImeOverlay(hostNode);
    overlay.render("한", { x: 12.4, y: 33.6, height: 19.2 });

    expect(hostNode.children).toHaveLength(1);
    const overlayNode = hostNode.children[0];
    expect(overlayNode.className).toBe("nx-xterm-ime-overlay");
    expect(overlayNode.textContent).toBe("한");
    expect(overlayNode.style.position).toBe("absolute");
    expect(overlayNode.style.transform).toBe(toXtermImeOverlayTransform({ x: 12.4, y: 33.6, height: 19.2 }));
    expect(overlayNode.style.minHeight).toBe("19px");

    overlay.dispose();
    expect(hostNode.children).toHaveLength(0);
    expect(hostNode.classList.has(XTERM_IME_PATCH_ROOT_CLASS)).toBeFalse();
  });
});
