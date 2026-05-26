import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import type { ITheme } from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import { fontFamily, DEFAULT_THEME, THEMES } from "../../../shared/design-tokens";
import type { ThemeId } from "../../../shared/design-tokens/themes";
import { TERMINAL_PALETTES } from "../../../shared/editor/terminal-palette";
import { resolvedTerminalCursorStyle, resolvedTerminalFontSize } from "../../state/stores/terminal";
import { createPtyClient } from "./pty-client";
import type {
  PtyClient,
  PtyClientOptions,
  TerminalController,
  TerminalControllerOptions,
  TerminalDimensions,
} from "./types";

type Disposable = { dispose: () => void };

type RendererAddon = CanvasAddon | WebglAddon;
interface TerminalLike {
  readonly element?: HTMLElement;
  readonly rows: number;
  options: { theme: ITheme | undefined; fontSize: number; cursorStyle: string };
  dispose: () => void;
  loadAddon: (addon: Disposable) => void;
  onData: (callback: (data: string) => void) => Disposable;
  open: (parent: HTMLElement) => void;
  refresh: (start: number, end: number) => void;
  write: (data: string) => void;
  attachCustomKeyEventHandler: (handler: (event: KeyboardEvent) => boolean) => void;
}
type FitAddonLike = Pick<FitAddon, "dispose" | "fit" | "proposeDimensions">;
type ResizeObserverLike = Pick<ResizeObserver, "disconnect" | "observe">;

export const TERMINAL_REOPENED_SEPARATOR = "─────────────  reopened  ─────────────";

export interface TerminalControllerDeps {
  waitForTerminalFonts: (fontSize: number) => Promise<void>;
  createTerminal: (options: ConstructorParameters<typeof Terminal>[0]) => TerminalLike;
  createFitAddon: () => FitAddonLike;
  createWebglAddon: () => WebglAddon;
  createCanvasAddon: () => CanvasAddon;
  createPtyClient: (options: PtyClientOptions) => PtyClient;
  createResizeObserver: (callback: ResizeObserverCallback) => ResizeObserverLike;
  requestAnimationFrame: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame: (handle: number) => void;
}

async function waitForTerminalFonts(fontSize: number): Promise<void> {
  try {
    await Promise.all([
      document.fonts.load(`${fontSize}px "JetBrains Mono Nerd Font"`),
      document.fonts.load(`${fontSize}px "Sarasa Term K"`),
    ]);
  } catch {
    // Degrade to available metrics rather than blocking the terminal.
  }
}

const defaultTerminalControllerDeps: TerminalControllerDeps = {
  waitForTerminalFonts,
  createTerminal: (options) => new Terminal(options) as unknown as TerminalLike,
  createFitAddon: () => new FitAddon(),
  createWebglAddon: () => new WebglAddon(),
  createCanvasAddon: () => new CanvasAddon(),
  createPtyClient,
  createResizeObserver: (callback) => new ResizeObserver(callback),
  requestAnimationFrame: (callback) => requestAnimationFrame(callback),
  cancelAnimationFrame: (handle) => cancelAnimationFrame(handle),
};

class XtermTerminalController implements TerminalController {
  private disposed = false;
  private term: TerminalLike | null = null;
  private fitAddon: FitAddonLike | null = null;
  private rendererAddon: RendererAddon | null = null;
  private dataDisposable: Disposable | null = null;
  private resizeObserver: ResizeObserverLike | null = null;
  private pendingRaf: number | null = null;
  private lastDims: TerminalDimensions | null = null;
  private ptyClient: PtyClient | null = null;
  private themeListener: ((e: Event) => void) | null = null;
  private terminalSettingsListener: ((e: Event) => void) | null = null;

  constructor(
    private readonly options: TerminalControllerOptions,
    private readonly deps: TerminalControllerDeps,
  ) {
    this.initialize().catch((error: unknown) => {
      if (!this.disposed) {
        this.term?.write(`\r\n[terminal initialization failed: ${String(error)}]\r\n`);
      }
    });
  }

  refresh(): void {
    if (this.disposed) return;
    const term = this.term;
    if (!term) return;
    // VSCode pattern (terminalInstance.ts L1057-1062): re-bind xterm to its
    // own element after a DOM reparent. `term.open(existingElement)`
    // re-attaches the DOM/canvas/webgl renderer to the (same) node and
    // restores rasterized state lost in transit. `refresh()` alone is
    // insufficient — the WebGL context is bound to the renderer that was
    // disconnected when the parent changed.
    const el = term.element;
    if (el) {
      term.open(el);
    }
    this.runFit();
    term.refresh(0, term.rows - 1);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.pendingRaf != null) {
      this.deps.cancelAnimationFrame(this.pendingRaf);
      this.pendingRaf = null;
    }

    if (this.themeListener) {
      document.documentElement.removeEventListener("nexus:theme-changed", this.themeListener);
      this.themeListener = null;
    }

    if (this.terminalSettingsListener) {
      window.removeEventListener("nexus:terminal-settings-changed", this.terminalSettingsListener);
      this.terminalSettingsListener = null;
    }

    this.dataDisposable?.dispose();
    this.dataDisposable = null;
    this.ptyClient?.dispose();
    this.ptyClient = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.rendererAddon?.dispose();
    this.rendererAddon = null;
    this.fitAddon?.dispose();
    this.fitAddon = null;
    this.term?.dispose();
    this.term = null;
  }

  async reopen(): Promise<void> {
    if (this.disposed) throw new Error("terminal disposed");
    const term = this.term;
    const ptyClient = this.ptyClient;
    if (!term || !ptyClient) throw new Error("terminal unavailable");

    const dimensions = this.currentDimensions();
    const result = await ptyClient.spawn(dimensions);
    // null means the session is already live — treat as a no-op so the caller
    // does not surface a spurious "Reopen failed." message to the user.
    if (result === null) return;
    term.write(`\r\n${TERMINAL_REOPENED_SEPARATOR}\r\n`);
  }

  private resolveCurrentThemeId(): ThemeId {
    const attr = document.documentElement.getAttribute("data-theme");
    // Validate via the theme registry — a string only passes if it's a
    // registered ThemeId. This lets us add themes without touching this
    // function. Using `in` (vs Object.prototype.hasOwnProperty.call) is safe
    // here because THEMES is a plain object literal with no prototype tricks.
    if (attr !== null && attr in THEMES) {
      return attr as ThemeId;
    }
    return DEFAULT_THEME;
  }

  applyTheme(themeId: ThemeId): void {
    if (this.disposed) return;
    const term = this.term;
    if (!term) return;
    term.options.theme = TERMINAL_PALETTES[themeId];
  }

  applyTerminalSettings(): void {
    if (this.disposed) return;
    const term = this.term;
    if (!term) return;
    term.options.fontSize = resolvedTerminalFontSize();
    term.options.cursorStyle = resolvedTerminalCursorStyle();
    // Re-fit after font size change so column/row counts stay accurate.
    this.runFit();
  }

  private async initialize(): Promise<void> {
    const fontSize = resolvedTerminalFontSize();
    await this.deps.waitForTerminalFonts(fontSize);
    if (this.disposed) return;

    const initialThemeId = this.resolveCurrentThemeId();

    const term = this.deps.createTerminal({
      cursorBlink: true,
      // allowTransparency lets the translucent theme `background` composite
      // over the macOS window vibrancy (whole-window translucency).
      allowTransparency: true,
      fontFamily: fontFamily.monoDisplay,
      fontSize,
      cursorStyle: resolvedTerminalCursorStyle(),
      theme: TERMINAL_PALETTES[initialThemeId],
    });
    this.term = term;

    // Subscribe to theme changes dispatched by use-theme-effect.ts.
    this.themeListener = (e: Event) => {
      const themeId = (e as CustomEvent<{ themeId: ThemeId }>).detail?.themeId;
      if (themeId) this.applyTheme(themeId);
    };
    document.documentElement.addEventListener("nexus:theme-changed", this.themeListener);

    // Subscribe to terminal user-settings changes dispatched by useTerminalStore setters.
    this.terminalSettingsListener = () => {
      this.applyTerminalSettings();
    };
    window.addEventListener("nexus:terminal-settings-changed", this.terminalSettingsListener);

    const fitAddon = this.deps.createFitAddon();
    this.fitAddon = fitAddon;
    term.loadAddon(fitAddon);
    this.loadRendererAddon(term);
    term.open(this.options.container);

    const initialDimensions = this.fitToContainer() ?? { cols: 80, rows: 24 };
    this.lastDims = initialDimensions;

    const ptyClient = this.deps.createPtyClient({
      workspaceId: this.options.workspaceId,
      tabId: this.options.tabId,
      cwd: this.options.cwd,
      onData: (chunk) => term.write(chunk),
      onExit: (args) => this.options.onExit?.(args),
    });
    this.ptyClient = ptyClient;

    this.dataDisposable = term.onData((data) => ptyClient.write(data));

    // Shift+Enter → "\\\r" (literal backslash + CR).
    //
    // 이유: xterm.js 의 기본 동작은 Shift+Enter 를 일반 Enter 와 동일하게 CR 만
    // 보낸다. Claude Code 같은 TUI 는 multi-line 입력을 "\" + Enter 패턴으로
    // universal 지원하고 (Anthropic 공식 문서), 일반 bash/zsh readline 도 동일
    // 패턴을 line continuation 으로 인식한다. 단일 sequence 로 두 환경 모두 호환.
    //
    // return false: xterm.js 의 기본 키 처리 (Enter → CR 전송) 를 차단.
    // attachCustomKeyEventHandler 의 contract 상 false 반환 시 default 처리 skip.
    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type === "keydown" && event.key === "Enter" && event.shiftKey) {
        ptyClient.write("\\\r");
        return false;
      }
      return true;
    });

    if (this.options.autoSpawn !== false) {
      ptyClient.spawn(initialDimensions).catch((error: unknown) => {
        if (!this.disposed) {
          term.write(`\r\n[spawn failed: ${String(error)}]\r\n`);
        }
      });
    }

    this.resizeObserver = this.deps.createResizeObserver(() => {
      if (this.pendingRaf != null) return;
      this.pendingRaf = this.deps.requestAnimationFrame(() => {
        this.pendingRaf = null;
        this.runFit();
      });
    });
    this.resizeObserver.observe(this.options.container);

    if (this.disposed) this.dispose();
  }

  private loadRendererAddon(term: TerminalLike): void {
    // Canvas renderer — NOT WebGL. The WebGL addon clears its canvas to an
    // opaque background and ignores `allowTransparency`, so the terminal can
    // never be translucent under it. The Canvas addon honors transparency,
    // which the whole-window vibrancy requires. Trade-off: Canvas is slightly
    // less performant than WebGL, accepted for the translucency feature.
    try {
      const canvas = this.deps.createCanvasAddon();
      term.loadAddon(canvas);
      this.rendererAddon = canvas;
    } catch {
      this.rendererAddon = null;
    }
  }

  private fitToContainer(): TerminalDimensions | null {
    if (!this.fitAddon) return null;
    if (this.options.container.clientWidth === 0 || this.options.container.clientHeight === 0) {
      return null;
    }

    const dimensions = this.fitAddon.proposeDimensions();
    if (!dimensions) return null;
    this.fitAddon.fit();
    return { cols: dimensions.cols, rows: dimensions.rows };
  }

  private currentDimensions(): TerminalDimensions {
    const dimensions = this.fitToContainer() ?? this.lastDims ?? { cols: 80, rows: 24 };
    this.lastDims = dimensions;
    return dimensions;
  }

  private runFit(): void {
    const dimensions = this.fitToContainer();
    if (!dimensions) return;
    if (this.lastDims?.cols === dimensions.cols && this.lastDims.rows === dimensions.rows) return;
    this.lastDims = dimensions;
    this.ptyClient?.resize(dimensions);
  }
}

export function createTerminalController(
  options: TerminalControllerOptions,
  deps: TerminalControllerDeps = defaultTerminalControllerDeps,
): TerminalController {
  return new XtermTerminalController(options, deps);
}
