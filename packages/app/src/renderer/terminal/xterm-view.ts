import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { XTERM_DEFAULT_FONT_FAMILY, ensureXtermFontStyle } from "./xterm-fonts";
import {
  XtermCompositionBuffer,
  XtermImeOverlay,
  ensureXtermImePatchStyle,
  handleEnterDuringComposition,
  type KeyboardEventLike,
  type OverlayHostLike,
  type XtermImeCursorAnchor,
} from "./xterm-ime-overlay";

export interface XtermResizeEvent {
  cols: number;
  rows: number;
}

export interface XtermDisposable {
  dispose(): void;
}

export interface XtermAddonLike extends XtermDisposable {}

export interface XtermFitAddonLike extends XtermAddonLike {
  fit(): void;
}

export interface XtermSearchAddonLike extends XtermAddonLike {
  findNext(term: string, searchOptions?: ISearchOptions): boolean;
  findPrevious(term: string, searchOptions?: ISearchOptions): boolean;
}

export interface XtermTerminalLike {
  readonly element?: HTMLElement;
  readonly rows: number;
  unicode: { activeVersion: string };
  loadAddon(addon: XtermAddonLike): void;
  open(container: HTMLElement): void;
  focus(): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  refresh(start: number, end: number): void;
  clearTextureAtlas(): void;
  input(data: string, wasUserInput?: boolean): void;
  onData(listener: (data: string) => void): XtermDisposable;
  onBinary?(listener: (data: string) => void): XtermDisposable;
  onResize(listener: (size: XtermResizeEvent) => void): XtermDisposable;
  onSelectionChange?(listener: () => void): XtermDisposable;
  hasSelection?(): boolean;
  getSelection?(): string;
  dispose(): void;
}

export interface XtermViewDependencies {
  createTerminal(options?: ITerminalOptions): XtermTerminalLike;
  createWebglAddon(): XtermAddonLike;
  createUnicode11Addon(): XtermAddonLike;
  createFitAddon(): XtermFitAddonLike;
  createSearchAddon(): XtermSearchAddonLike;
}

export interface XtermViewOptions {
  terminalOptions?: ITerminalOptions;
  onInput?: (data: string) => void;
  onBinaryInput?: (data: string) => void;
  onResize?: (size: XtermResizeEvent) => void;
  getImeCursorAnchor?: () => XtermImeCursorAnchor | null;
}

export const XTERM_DEFAULT_SCROLLBACK_LINES = 10_000;

const DEFAULT_XTERM_VIEW_DEPENDENCIES: XtermViewDependencies = {
  createTerminal: (options) => new Terminal(options),
  createWebglAddon: () => new WebglAddon(),
  createUnicode11Addon: () => new Unicode11Addon(),
  createFitAddon: () => new FitAddon(),
  createSearchAddon: () => new SearchAddon(),
};

function resolveTerminalOptions(terminalOptions?: ITerminalOptions): ITerminalOptions {
  return {
    ...terminalOptions,
    allowProposedApi: true,
    fontFamily: terminalOptions?.fontFamily ?? XTERM_DEFAULT_FONT_FAMILY,
    scrollback: terminalOptions?.scrollback ?? XTERM_DEFAULT_SCROLLBACK_LINES,
  };
}

export class XtermView {
  private readonly terminal: XtermTerminalLike;
  private readonly webglAddon: XtermAddonLike;
  private readonly unicode11Addon: XtermAddonLike;
  private readonly fitAddon: XtermFitAddonLike;
  private readonly searchAddon: XtermSearchAddonLike;
  private readonly onInput?: (data: string) => void;
  private readonly getImeCursorAnchor?: () => XtermImeCursorAnchor | null;
  private readonly eventDisposables: XtermDisposable[] = [];
  private readonly imeEventRemovers: Array<() => void> = [];
  private readonly compositionBuffer = new XtermCompositionBuffer();

  private coreAddonsLoaded = false;
  private webglAddonLoaded = false;
  private mounted = false;
  private mountedContainer: HTMLElement | null = null;
  private disposed = false;
  private imeOverlay: XtermImeOverlay | null = null;

  public constructor(
    options: XtermViewOptions = {},
    dependencies: XtermViewDependencies = DEFAULT_XTERM_VIEW_DEPENDENCIES,
  ) {
    this.terminal = dependencies.createTerminal(resolveTerminalOptions(options.terminalOptions));
    this.webglAddon = dependencies.createWebglAddon();
    this.unicode11Addon = dependencies.createUnicode11Addon();
    this.fitAddon = dependencies.createFitAddon();
    this.searchAddon = dependencies.createSearchAddon();
    this.onInput = options.onInput;
    this.getImeCursorAnchor = options.getImeCursorAnchor;

    if (this.onInput) {
      this.eventDisposables.push(
        this.terminal.onData((data) => {
          if (!this.compositionBuffer.shouldForwardTerminalData(data)) {
            return;
          }
          this.onInput?.(data);
        }),
      );
    }
    if (options.onBinaryInput && this.terminal.onBinary) {
      this.eventDisposables.push(this.terminal.onBinary(options.onBinaryInput));
    }
    if (options.onResize) {
      this.eventDisposables.push(this.terminal.onResize(options.onResize));
    }
  }

  public mount(container: HTMLElement | null | undefined): boolean {
    if (this.disposed || !container) {
      return false;
    }
    if (this.mounted && this.mountedContainer === container) {
      this.fitAddon.fit();
      return true;
    }

    this.ensureCoreAddons();

    if (this.terminal.element) {
      this.disposeImeHandling();
      container.appendChild(this.terminal.element);
      this.setupImeHandling(container);
      this.fitAddon.fit();
      this.mounted = true;
      this.mountedContainer = container;
      return true;
    }

    try {
      this.terminal.open(container);
    } catch {
      return false;
    }

    this.setupImeHandling(container);
    this.terminal.unicode.activeVersion = "11";
    this.ensureWebglAddon();
    this.fitAddon.fit();
    this.mounted = true;
    this.mountedContainer = container;
    return true;
  }

  public detach(): void {
    if (this.disposed || !this.mounted) {
      return;
    }

    this.disposeImeHandling();
    this.mounted = false;
    this.mountedContainer = null;
  }

  public unmount(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.mounted = false;
    this.mountedContainer = null;
    this.disposeImeHandling();
    for (const disposable of this.eventDisposables) {
      disposable.dispose();
    }
    this.eventDisposables.length = 0;
    this.terminal.dispose();
  }

  public dispatchInput(data: string, wasUserInput = true): void {
    if (this.disposed) {
      return;
    }
    this.terminal.input(data, wasUserInput);
  }

  public focus(): void {
    if (this.disposed || !this.mounted) {
      return;
    }
    this.terminal.focus();
  }

  public write(data: string): void {
    if (this.disposed) {
      return;
    }
    this.terminal.write(data);
  }

  public resize(cols: number, rows: number): void {
    if (this.disposed) {
      return;
    }
    this.terminal.resize(cols, rows);
  }

  public fit(): void {
    if (this.disposed) {
      return;
    }
    this.fitAddon.fit();
    this.repairRendererAfterVisibilityChange();
  }

  public searchNext(term: string, searchOptions?: ISearchOptions): boolean {
    if (this.disposed) {
      return false;
    }
    return this.searchAddon.findNext(term, searchOptions);
  }

  public searchPrevious(term: string, searchOptions?: ISearchOptions): boolean {
    if (this.disposed) {
      return false;
    }
    return this.searchAddon.findPrevious(term, searchOptions);
  }

  public onSelectionChange(listener: () => void): XtermDisposable {
    if (this.disposed || !this.terminal.onSelectionChange) {
      return {
        dispose: () => {
          // no-op
        },
      };
    }

    const subscription = this.terminal.onSelectionChange(listener);
    this.eventDisposables.push(subscription);
    return subscription;
  }

  public hasSelection(): boolean {
    if (this.disposed) {
      return false;
    }

    return this.terminal.hasSelection?.() ?? false;
  }

  public getSelection(): string {
    if (this.disposed) {
      return "";
    }

    return this.terminal.getSelection?.() ?? "";
  }

  private ensureCoreAddons(): void {
    if (this.coreAddonsLoaded) {
      return;
    }
    this.terminal.loadAddon(this.unicode11Addon);
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(this.searchAddon);
    this.coreAddonsLoaded = true;
  }

  private ensureWebglAddon(): void {
    if (this.webglAddonLoaded) {
      return;
    }

    try {
      this.terminal.loadAddon(this.webglAddon);
      this.webglAddonLoaded = true;
    } catch {
      this.webglAddonLoaded = false;
    }
  }

  private repairRendererAfterVisibilityChange(): void {
    const lastRowIndex = Math.max(0, this.terminal.rows - 1);
    this.terminal.clearTextureAtlas();
    this.terminal.refresh(0, lastRowIndex);
  }

  private setupImeHandling(container: HTMLElement): void {
    ensureXtermFontStyle((container as OverlayHostLike).ownerDocument);
    ensureXtermImePatchStyle((container as OverlayHostLike).ownerDocument);
    this.imeOverlay = new XtermImeOverlay(container as unknown as OverlayHostLike);

    const helperTextarea = this.findHelperTextarea(container);
    if (!helperTextarea) {
      return;
    }

    const handleCompositionStart = (): void => {
      this.compositionBuffer.start();
      this.imeOverlay?.render(this.compositionBuffer.getBufferedText(), this.resolveImeCursorAnchor());
    };
    const handleCompositionUpdate = (event: { data?: string | null }): void => {
      this.compositionBuffer.update(event.data ?? "");
      this.imeOverlay?.render(this.compositionBuffer.getBufferedText(), this.resolveImeCursorAnchor());
    };
    const handleCompositionEnd = (event: { data?: string | null }): void => {
      const committedText = this.compositionBuffer.end(event.data ?? "");
      this.imeOverlay?.hide();
      if (!committedText) {
        return;
      }
      this.onInput?.(committedText);
    };
    const handleKeyDown = (event: KeyboardEventLike): void => {
      handleEnterDuringComposition(event);
    };

    this.addImeListener(helperTextarea, "compositionstart", handleCompositionStart);
    this.addImeListener(helperTextarea, "compositionupdate", handleCompositionUpdate);
    this.addImeListener(helperTextarea, "compositionend", handleCompositionEnd);
    this.addImeListener(helperTextarea, "keydown", handleKeyDown);
  }

  private disposeImeHandling(): void {
    for (const removeListener of this.imeEventRemovers) {
      removeListener();
    }
    this.imeEventRemovers.length = 0;
    this.compositionBuffer.reset();
    this.imeOverlay?.dispose();
    this.imeOverlay = null;
  }

  private resolveImeCursorAnchor(): XtermImeCursorAnchor | null {
    return this.getImeCursorAnchor?.() ?? null;
  }

  private findHelperTextarea(
    container: HTMLElement,
  ): {
    addEventListener?(type: string, listener: unknown): void;
    removeEventListener?(type: string, listener: unknown): void;
  } | null {
    const node = (
      container as unknown as {
        querySelector?(selector: string): unknown;
      }
    ).querySelector?.(".xterm-helper-textarea");
    if (!node) {
      return null;
    }
    return node as {
      addEventListener?(type: string, listener: unknown): void;
      removeEventListener?(type: string, listener: unknown): void;
    };
  }

  private addImeListener(
    target: {
      addEventListener?(type: string, listener: unknown): void;
      removeEventListener?(type: string, listener: unknown): void;
    },
    eventName: string,
    listener: unknown,
  ): void {
    target.addEventListener?.(eventName, listener);
    this.imeEventRemovers.push(() => {
      target.removeEventListener?.(eventName, listener);
    });
  }
}
