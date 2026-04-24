import { describe, expect, test } from "bun:test";

import {
  XtermView,
  XTERM_DEFAULT_SCROLLBACK_LINES,
  type XtermAddonLike,
  type XtermDisposable,
  type XtermFitAddonLike,
  type XtermResizeEvent,
  type XtermSearchAddonLike,
  type XtermTerminalLike,
  type XtermViewDependencies,
} from "./xterm-view";
import {
  XTERM_DEFAULT_FONT_FAMILY,
  XTERM_FONT_STYLE_ELEMENT_ID,
} from "./xterm-fonts";

class FakeAddon implements XtermAddonLike {
  public disposeCount = 0;

  public dispose(): void {
    this.disposeCount += 1;
  }
}

class FakeFitAddon extends FakeAddon implements XtermFitAddonLike {
  public fitCount = 0;

  public fit(): void {
    this.fitCount += 1;
  }
}

class FakeSearchAddon extends FakeAddon implements XtermSearchAddonLike {
  public findNextCalls: Array<{
    term: string;
    searchOptions: Parameters<XtermSearchAddonLike["findNext"]>[1];
  }> = [];
  public findPreviousCalls: Array<{
    term: string;
    searchOptions: Parameters<XtermSearchAddonLike["findPrevious"]>[1];
  }> = [];

  public findNext(
    term: string,
    searchOptions?: Parameters<XtermSearchAddonLike["findNext"]>[1],
  ): boolean {
    this.findNextCalls.push({ term, searchOptions });
    return true;
  }

  public findPrevious(
    term: string,
    searchOptions?: Parameters<XtermSearchAddonLike["findPrevious"]>[1],
  ): boolean {
    this.findPreviousCalls.push({ term, searchOptions });
    return false;
  }
}

class FakeTerminal implements XtermTerminalLike {
  public readonly rows = 30;
  public readonly unicode = { activeVersion: "0" };

  public readonly loadedAddons: XtermAddonLike[] = [];
  public readonly writes: string[] = [];
  public readonly inputs: Array<{ data: string; wasUserInput: boolean | undefined }> = [];
  public readonly resizes: Array<{ cols: number; rows: number }> = [];
  public readonly refreshCalls: Array<{ start: number; end: number }> = [];
  public openCount = 0;
  public focusCount = 0;
  public clearTextureAtlasCount = 0;
  public disposeCount = 0;
  public throwOnOpen = false;
  public dataListener: ((data: string) => void) | null = null;
  public resizeListener: ((size: XtermResizeEvent) => void) | null = null;
  public selectionListener: (() => void) | null = null;
  public dataSubscriptionDisposeCount = 0;
  public resizeSubscriptionDisposeCount = 0;
  public selectionSubscriptionDisposeCount = 0;
  public hasSelectionValue = false;
  public selectionText = "";

  public loadAddon(addon: XtermAddonLike): void {
    this.loadedAddons.push(addon);
  }

  public open(_container: HTMLElement): void {
    if (this.throwOnOpen) {
      throw new Error("open failed");
    }
    this.openCount += 1;
  }

  public focus(): void {
    this.focusCount += 1;
  }

  public write(data: string): void {
    this.writes.push(data);
  }

  public resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  public refresh(start: number, end: number): void {
    this.refreshCalls.push({ start, end });
  }

  public clearTextureAtlas(): void {
    this.clearTextureAtlasCount += 1;
  }

  public input(data: string, wasUserInput?: boolean): void {
    this.inputs.push({ data, wasUserInput });
  }

  public onData(listener: (data: string) => void): XtermDisposable {
    this.dataListener = listener;
    return {
      dispose: () => {
        this.dataSubscriptionDisposeCount += 1;
      },
    };
  }

  public onResize(listener: (size: XtermResizeEvent) => void): XtermDisposable {
    this.resizeListener = listener;
    return {
      dispose: () => {
        this.resizeSubscriptionDisposeCount += 1;
      },
    };
  }

  public onSelectionChange(listener: () => void): XtermDisposable {
    this.selectionListener = listener;
    return {
      dispose: () => {
        this.selectionSubscriptionDisposeCount += 1;
      },
    };
  }

  public hasSelection(): boolean {
    return this.hasSelectionValue;
  }

  public getSelection(): string {
    return this.selectionText;
  }

  public dispose(): void {
    this.disposeCount += 1;
    for (const addon of this.loadedAddons) {
      addon.dispose();
    }
  }
}

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  public addEventListener(type: string, listener: unknown): void {
    const typedListener = listener as (event: unknown) => void;
    const handlers = this.listeners.get(type);
    if (handlers) {
      handlers.add(typedListener);
      return;
    }
    this.listeners.set(type, new Set([typedListener]));
  }

  public removeEventListener(type: string, listener: unknown): void {
    this.listeners.get(type)?.delete(listener as (event: unknown) => void);
  }

  public dispatch(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class FakeStyleNode {
  public id = "";
  public textContent: string | null = "";
}

class FakeDocument {
  public readonly styleNodes: FakeStyleNode[] = [];
  public readonly head = {
    appendChild: (node: unknown): void => {
      this.styleNodes.push(node as FakeStyleNode);
    },
  };

  public getElementById(id: string): unknown {
    return this.styleNodes.find((node) => node.id === id) ?? null;
  }

  public createElement(_tagName: string): FakeStyleNode {
    return new FakeStyleNode();
  }
}

class FakeContainer {
  public readonly textarea = new FakeEventTarget();
  public readonly style: { position?: string } = {};
  public readonly ownerDocument?: FakeDocument;

  public constructor(ownerDocument?: FakeDocument) {
    this.ownerDocument = ownerDocument;
  }

  public querySelector(selector: string): unknown {
    if (selector === ".xterm-helper-textarea") {
      return this.textarea;
    }
    return null;
  }
}

describe("XtermView", () => {
  test("applies the default terminal font stack when terminalOptions.fontFamily is unset", () => {
    const terminal = new FakeTerminal();
    let createTerminalOptions: Record<string, unknown> | undefined;
    const dependencies: XtermViewDependencies = {
      createTerminal: (options) => {
        createTerminalOptions = options as Record<string, unknown> | undefined;
        return terminal;
      },
      createWebglAddon: () => new FakeAddon(),
      createUnicode11Addon: () => new FakeAddon(),
      createFitAddon: () => new FakeFitAddon(),
      createSearchAddon: () => new FakeSearchAddon(),
    };

    const view = new XtermView({}, dependencies);
    expect(createTerminalOptions?.allowProposedApi).toBe(true);
    expect(createTerminalOptions?.fontFamily).toBe(XTERM_DEFAULT_FONT_FAMILY);
    expect(createTerminalOptions?.scrollback).toBe(XTERM_DEFAULT_SCROLLBACK_LINES);
    view.unmount();
  });

  test("preserves explicit terminal font and scrollback options", () => {
    const terminal = new FakeTerminal();
    let createTerminalOptions: Record<string, unknown> | undefined;
    const dependencies: XtermViewDependencies = {
      createTerminal: (options) => {
        createTerminalOptions = options as Record<string, unknown> | undefined;
        return terminal;
      },
      createWebglAddon: () => new FakeAddon(),
      createUnicode11Addon: () => new FakeAddon(),
      createFitAddon: () => new FakeFitAddon(),
      createSearchAddon: () => new FakeSearchAddon(),
    };

    const view = new XtermView(
      {
        terminalOptions: {
          allowProposedApi: false,
          fontFamily: "Custom Mono",
          scrollback: 1234,
        },
      },
      dependencies,
    );

    expect(createTerminalOptions?.allowProposedApi).toBe(true);
    expect(createTerminalOptions?.fontFamily).toBe("Custom Mono");
    expect(createTerminalOptions?.scrollback).toBe(1234);
    view.unmount();
  });

  test("injects the bundled font-face style only once", () => {
    const terminal = new FakeTerminal();
    const dependencies: XtermViewDependencies = {
      createTerminal: () => terminal,
      createWebglAddon: () => new FakeAddon(),
      createUnicode11Addon: () => new FakeAddon(),
      createFitAddon: () => new FakeFitAddon(),
      createSearchAddon: () => new FakeSearchAddon(),
    };
    const fakeDocument = new FakeDocument();
    const container = new FakeContainer(fakeDocument);
    const view = new XtermView({}, dependencies);

    expect(view.mount(container as unknown as HTMLElement)).toBeTrue();
    expect(view.mount(container as unknown as HTMLElement)).toBeTrue();

    expect(fakeDocument.styleNodes.filter((node) => node.id === XTERM_FONT_STYLE_ELEMENT_ID)).toHaveLength(1);

    view.unmount();
  });

  test("mounts with WebGL/Unicode/Fit/Search addons and disposes cleanly", () => {
    const terminal = new FakeTerminal();
    const webglAddon = new FakeAddon();
    const unicodeAddon = new FakeAddon();
    const fitAddon = new FakeFitAddon();
    const searchAddon = new FakeSearchAddon();
    const dependencies: XtermViewDependencies = {
      createTerminal: () => terminal,
      createWebglAddon: () => webglAddon,
      createUnicode11Addon: () => unicodeAddon,
      createFitAddon: () => fitAddon,
      createSearchAddon: () => searchAddon,
    };

    const receivedInput: string[] = [];
    const receivedResize: XtermResizeEvent[] = [];
    const view = new XtermView(
      {
        onInput: (data) => {
          receivedInput.push(data);
        },
        onResize: (size) => {
          receivedResize.push(size);
        },
      },
      dependencies,
    );

    const mountResult = view.mount({} as unknown as HTMLElement);
    expect(mountResult).toBeTrue();
    expect(terminal.openCount).toBe(1);
    expect(terminal.unicode.activeVersion).toBe("11");
    expect(terminal.loadedAddons).toEqual([unicodeAddon, fitAddon, searchAddon, webglAddon]);
    expect(fitAddon.fitCount).toBe(1);
    expect(terminal.clearTextureAtlasCount).toBe(0);
    expect(terminal.refreshCalls).toEqual([]);

    view.focus();
    view.dispatchInput("whoami");
    view.write("stdout chunk");
    view.resize(120, 30);
    expect(view.searchNext("hello")).toBeTrue();
    expect(view.searchPrevious("hello")).toBeFalse();
    const selectionEvents: string[] = [];
    view.onSelectionChange(() => {
      selectionEvents.push("selection");
    });
    terminal.hasSelectionValue = true;
    terminal.selectionText = "selected text";
    terminal.selectionListener?.();

    expect(terminal.focusCount).toBe(1);
    expect(terminal.inputs).toEqual([{ data: "whoami", wasUserInput: true }]);
    expect(terminal.writes).toEqual(["stdout chunk"]);
    expect(terminal.resizes).toEqual([{ cols: 120, rows: 30 }]);
    expect(searchAddon.findNextCalls[0]?.term).toBe("hello");
    expect(searchAddon.findPreviousCalls[0]?.term).toBe("hello");
    expect(view.hasSelection()).toBeTrue();
    expect(view.getSelection()).toBe("selected text");
    expect(selectionEvents).toEqual(["selection"]);

    terminal.dataListener?.("typed");
    terminal.resizeListener?.({ cols: 80, rows: 24 });
    expect(receivedInput).toEqual(["typed"]);
    expect(receivedResize).toEqual([{ cols: 80, rows: 24 }]);

    view.unmount();
    expect(terminal.disposeCount).toBe(1);
    expect(terminal.dataSubscriptionDisposeCount).toBe(1);
    expect(terminal.resizeSubscriptionDisposeCount).toBe(1);
    expect(terminal.selectionSubscriptionDisposeCount).toBe(1);
    expect(unicodeAddon.disposeCount).toBe(1);
    expect(fitAddon.disposeCount).toBe(1);
    expect(searchAddon.disposeCount).toBe(1);
    expect(webglAddon.disposeCount).toBe(1);

    view.dispatchInput("after-dispose");
    view.focus();
    view.write("after-dispose");
    view.resize(1, 1);
    expect(terminal.focusCount).toBe(1);
    expect(terminal.inputs).toHaveLength(1);
    expect(terminal.writes).toHaveLength(1);
    expect(terminal.resizes).toHaveLength(1);
  });

  test("repairs WebGL texture atlas and refreshes all rows when fit is called after visibility changes", () => {
    const terminal = new FakeTerminal();
    const fitAddon = new FakeFitAddon();
    const dependencies: XtermViewDependencies = {
      createTerminal: () => terminal,
      createWebglAddon: () => new FakeAddon(),
      createUnicode11Addon: () => new FakeAddon(),
      createFitAddon: () => fitAddon,
      createSearchAddon: () => new FakeSearchAddon(),
    };
    const view = new XtermView({}, dependencies);

    expect(view.mount({} as unknown as HTMLElement)).toBeTrue();
    view.fit();

    expect(fitAddon.fitCount).toBe(2);
    expect(terminal.clearTextureAtlasCount).toBe(1);
    expect(terminal.refreshCalls).toEqual([{ start: 0, end: 29 }]);

    view.unmount();
  });

  test("returns false if mount cannot open in non-DOM environment", () => {
    const terminal = new FakeTerminal();
    terminal.throwOnOpen = true;
    const dependencies: XtermViewDependencies = {
      createTerminal: () => terminal,
      createWebglAddon: () => new FakeAddon(),
      createUnicode11Addon: () => new FakeAddon(),
      createFitAddon: () => new FakeFitAddon(),
      createSearchAddon: () => new FakeSearchAddon(),
    };

    const view = new XtermView({}, dependencies);
    expect(view.mount({} as unknown as HTMLElement)).toBeFalse();
    view.unmount();
    expect(terminal.disposeCount).toBe(1);
  });

  test("swallows Enter while composing and flushes composition buffer once", () => {
    const terminal = new FakeTerminal();
    const dependencies: XtermViewDependencies = {
      createTerminal: () => terminal,
      createWebglAddon: () => new FakeAddon(),
      createUnicode11Addon: () => new FakeAddon(),
      createFitAddon: () => new FakeFitAddon(),
      createSearchAddon: () => new FakeSearchAddon(),
    };
    const receivedInput: string[] = [];
    const view = new XtermView(
      {
        onInput: (data) => {
          receivedInput.push(data);
        },
        getImeCursorAnchor: () => ({ x: 11, y: 22, height: 18 }),
      },
      dependencies,
    );
    const container = new FakeContainer();

    expect(view.mount(container as unknown as HTMLElement)).toBeTrue();

    const composingEnterEvent = {
      key: "Enter",
      isComposing: true,
      preventDefaultCount: 0,
      stopPropagationCount: 0,
      preventDefault(): void {
        this.preventDefaultCount += 1;
      },
      stopPropagation(): void {
        this.stopPropagationCount += 1;
      },
    };
    container.textarea.dispatch("compositionstart");
    container.textarea.dispatch("compositionupdate", { data: "ㅎ" });
    container.textarea.dispatch("compositionupdate", { data: "한" });
    container.textarea.dispatch("keydown", composingEnterEvent);

    expect(composingEnterEvent.preventDefaultCount).toBe(1);
    expect(composingEnterEvent.stopPropagationCount).toBe(1);

    terminal.dataListener?.("한");
    expect(receivedInput).toEqual([]);

    container.textarea.dispatch("compositionend", { data: "" });
    expect(receivedInput).toEqual(["한"]);

    terminal.dataListener?.("한");
    expect(receivedInput).toEqual(["한"]);

    const plainEnterEvent = {
      key: "Enter",
      isComposing: false,
      preventDefaultCount: 0,
      stopPropagationCount: 0,
      preventDefault(): void {
        this.preventDefaultCount += 1;
      },
      stopPropagation(): void {
        this.stopPropagationCount += 1;
      },
    };
    container.textarea.dispatch("keydown", plainEnterEvent);
    expect(plainEnterEvent.preventDefaultCount).toBe(0);
    expect(plainEnterEvent.stopPropagationCount).toBe(0);

    terminal.dataListener?.("\\r");
    expect(receivedInput).toEqual(["한", "\\r"]);

    view.unmount();
  });
});
