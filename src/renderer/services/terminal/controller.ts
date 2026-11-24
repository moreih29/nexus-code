import { FitAddon } from "@xterm/addon-fit";
import type { ITheme } from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import i18next from "i18next";
import { DEFAULT_THEME, THEMES } from "../../../shared/design-tokens";
import type { ThemeId } from "../../../shared/design-tokens/themes";
import { TERMINAL_PALETTES } from "../../../shared/editor/terminal-palette";
import { createLogger } from "../../../shared/log/renderer";
import { isLoginShell } from "../../../shared/pty/login-shell";
import { ipcCallResult } from "../../ipc/client";
import { useTabsStore } from "../../state/stores/tabs";
import {
  resolvedTerminalCursorStyle,
  resolvedTerminalFontFamily,
  resolvedTerminalFontLigatures,
  resolvedTerminalFontSize,
} from "../../state/stores/terminal";
import { copyTextViaIpc } from "../../utils/clipboard";
import { isWindows } from "../../utils/platform";
import {
  type AnsiBufferLike,
  type AnsiLineLike,
  type AnsiScreen,
  bufferAnsi,
  bufferScreen,
} from "./buffer-ansi";
import { installCursorBlink } from "./cursor-blink";
import { clipboardTextOf } from "./osc-clipboard";
import { createPtyClient, STARTUP_INPUT_MAX_WAIT_MS, STARTUP_INPUT_QUIET_MS } from "./pty-client";
import { requestTerminalReopen } from "./reopen-requests";
import type {
  PtyClient,
  PtyClientOptions,
  SpawnedSession,
  TerminalController,
  TerminalControllerOptions,
  TerminalDimensions,
  TerminalInputCheckpoint,
} from "./types";

const log = createLogger("terminal");

type Disposable = { dispose: () => void };

const reportedMissingShells = new Set<string>();

function reportMissingShell(name: string): void {
  if (reportedMissingShells.has(name)) return;
  reportedMissingShells.add(name);
  const message =
    name === ""
      ? i18next.t("common:terminal.shell_removed")
      : i18next.t("common:terminal.shell_missing", { name });
  void import("../../components/ui/toast").then(({ showToast }) =>
    showToast({ kind: "warning", message }),
  );
}

type OscHandlerCallback = (data: string) => boolean | Promise<boolean>;
type CsiParamsLike = ReadonlyArray<number | number[]>;
interface ParserLike {
  registerOscHandler: (ident: number, callback: OscHandlerCallback) => Disposable;
  registerCsiHandler: (
    id: { prefix?: string; intermediates?: string; final: string },
    callback: (params: CsiParamsLike) => boolean,
  ) => Disposable;
  registerEscHandler: (
    id: { intermediates?: string; final: string },
    callback: () => boolean,
  ) => Disposable;
}

interface BufferLike extends AnsiBufferLike {
  readonly type: "normal" | "alternate";
  readonly length?: number;
  getLine?(y: number): AnsiLineLike | undefined;
  readonly cursorX?: number;
  readonly cursorY?: number;
  readonly baseY?: number;
}

interface TerminalLike {
  readonly element?: HTMLElement;
  readonly textarea?: HTMLTextAreaElement;
  readonly rows: number;
  readonly parser: ParserLike;
  readonly buffer: { active: BufferLike };
  readonly modes: { readonly bracketedPasteMode: boolean; readonly sendFocusMode: boolean };
  options: {
    theme: ITheme | undefined;
    fontSize: number;
    cursorStyle: string;
    fontFamily: string;
  };
  dispose: () => void;
  loadAddon: (addon: Disposable) => void;
  onData: (callback: (data: string) => void) => Disposable;
  onSelectionChange: (callback: () => void) => Disposable;
  onTitleChange: (callback: (title: string) => void) => Disposable;
  getSelection: () => string;
  clearSelection: () => void;
  open: (parent: HTMLElement) => void;
  refresh: (start: number, end: number) => void;
  write: (data: string, callback?: () => void) => void;
  paste: (data: string) => void;
  attachCustomKeyEventHandler: (handler: (event: KeyboardEvent) => boolean) => void;
  focus: () => void;
}
type FitAddonLike = Pick<FitAddon, "dispose" | "fit" | "proposeDimensions">;
type CreateLigaturesAddon = () => Disposable;
type ResizeObserverLike = Pick<ResizeObserver, "disconnect" | "observe">;

export const TERMINAL_REOPENED_SEPARATOR = "─────────────  reopened  ─────────────";

export function isShellPromptLikeTitle(title: string): boolean {
  if (title.includes("/") || title.includes("\\")) return true;
  if (title.startsWith("~")) return true;
  if (title.includes("@") && title.includes(":")) return true;
  return false;
}

export { isLoginShell };

export type OscTitleAction = "ignore" | "apply" | "clear" | "confirm";

export function classifyOscTitle(
  title: string,
  bufferType: "normal" | "alternate",
): OscTitleAction {
  if (bufferType === "alternate") {
    return isShellPromptLikeTitle(title) ? "ignore" : "apply";
  }
  if (isShellPromptLikeTitle(title)) return "clear";
  return "confirm";
}

const REMOTE_LOGINS: ReadonlySet<string> = new Set([
  "ssh",
  "autossh",
  "mosh",
  "mosh-client",
  "et",
  "telnet",
]);

export function foregroundConfirmsTitle(foregroundName: string): boolean {
  const name = foregroundName.trim();
  return name !== "" && !isLoginShell(name) && !REMOTE_LOGINS.has(name.toLowerCase());
}

const FOCUS_REPORTING_MODE = 1004;
const BRACKETED_PASTE_MODE = 2004;
const CURSOR_MODE = 25;
const FOCUS_REPORT_DELAY_MS = 250;
const FOCUS_OUT_REPORT = "\x1b[O";

function hasKeyboardFocus(term: Pick<TerminalLike, "textarea">): boolean {
  return (
    document.hasFocus() && term.textarea !== undefined && document.activeElement === term.textarea
  );
}

export function escapeDroppedPath(path: string, shellPath?: string): string {
  const shell = shellPath?.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (shell === "powershell.exe" || shell === "pwsh.exe" || shell === "pwsh") {
    return /[\s'"`$&(){}[\];,@#|<>‘’‚‛]/.test(path)
      ? `'${path.replace(/['‘’‚‛]/g, "$&$&")}'`
      : path;
  }
  if (shell === "cmd.exe") {
    return /[\s&()[\]{}^=;!'+,`~]/.test(path) ? `"${path}"` : path;
  }
  return path.replace(/[\s'"\\$`(){}[\]<>|&;*?!#~]/g, "\\$&");
}

const OSC_CURSOR_KEYWORDS: ReadonlySet<string> = new Set([
  "auto",
  "default",
  "none",
  "context-menu",
  "help",
  "pointer",
  "progress",
  "wait",
  "cell",
  "crosshair",
  "text",
  "vertical-text",
  "alias",
  "copy",
  "move",
  "no-drop",
  "not-allowed",
  "grab",
  "grabbing",
  "all-scroll",
  "col-resize",
  "row-resize",
  "n-resize",
  "e-resize",
  "s-resize",
  "w-resize",
  "ne-resize",
  "nw-resize",
  "se-resize",
  "sw-resize",
  "ew-resize",
  "ns-resize",
  "nesw-resize",
  "nwse-resize",
  "zoom-in",
  "zoom-out",
]);

export function oscCursorStyle(data: string): string {
  const keyword = data.trim().toLowerCase();
  return OSC_CURSOR_KEYWORDS.has(keyword) ? keyword : "";
}

export interface TerminalControllerDeps {
  waitForTerminalFonts: (fontSize: number) => Promise<void>;
  createTerminal: (options: ConstructorParameters<typeof Terminal>[0]) => TerminalLike;
  createFitAddon: () => FitAddonLike;
  loadLigaturesAddon: () => Promise<CreateLigaturesAddon>;
  createPtyClient: (options: PtyClientOptions) => PtyClient;
  createResizeObserver: (callback: ResizeObserverCallback) => ResizeObserverLike;
  requestAnimationFrame: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame: (handle: number) => void;
}

async function waitForTerminalFonts(fontSize: number): Promise<void> {
  try {
    await Promise.allSettled([
      document.fonts.load(`${fontSize}px "JetBrains Mono Nerd Font"`),
      document.fonts.load(`${fontSize}px "Sarasa Term K"`),
      document.fonts.load(`${fontSize}px "D2CodingLigature Nerd Font"`),
    ]);
  } catch {}
}

const defaultTerminalControllerDeps: TerminalControllerDeps = {
  waitForTerminalFonts,
  createTerminal: (options) => new Terminal(options) as unknown as TerminalLike,
  createFitAddon: () => new FitAddon(),
  loadLigaturesAddon: async () => {
    const { LigaturesAddon } = await import("@xterm/addon-ligatures");
    return () => new LigaturesAddon();
  },
  createPtyClient,
  createResizeObserver: (callback) => new ResizeObserver(callback),
  requestAnimationFrame: (callback) => requestAnimationFrame(callback),
  cancelAnimationFrame: (handle) => cancelAnimationFrame(handle),
};

class XtermTerminalController implements TerminalController {
  private disposed = false;
  private sandboxSessionId = crypto.randomUUID();
  private reopenEnterHeld = false;
  private shellPath: string | undefined;
  private shellIsPowerShell = false;
  private heldPaste = false;
  private pasteDisposable: (() => void) | null = null;
  private shellTakesHomeEnd = false;
  private term: TerminalLike | null = null;
  private fitAddon: FitAddonLike | null = null;
  private ligaturesAddon: Disposable | null = null;
  private dataDisposable: Disposable | null = null;
  private selectionDisposable: Disposable | null = null;
  private titleDisposable: Disposable | null = null;
  private titleCount = 0;
  private altEnterDisposable: Disposable | null = null;
  private altExitDisposable: Disposable | null = null;
  private focusReportDisposable: Disposable | null = null;
  private cursorHidden = false;
  private cursorDisposables: Disposable[] = [];
  private cursorBlink: ReturnType<typeof installCursorBlink> | undefined;
  private focusReportTimer: ReturnType<typeof setTimeout> | null = null;
  private selectionWriteTimer: ReturnType<typeof setTimeout> | null = null;
  private oscDisposables: Disposable[] = [];
  private resizeObserver: ResizeObserverLike | null = null;
  private pendingRaf: number | null = null;
  private lastDims: TerminalDimensions | null = null;
  private ptyClient: PtyClient | null = null;
  private themeListener: ((e: Event) => void) | null = null;
  private terminalSettingsListener: ((e: Event) => void) | null = null;
  private dropDisposable: (() => void) | null = null;
  private replayWritesPending = 0;
  private readonly outputWaiters = new Set<(shown: boolean) => void>();
  private readonly outputListeners = new Set<(ended: boolean) => void>();
  private inputCheckpoint: TerminalInputCheckpoint = { hasInput: false };
  private readonly inputListeners = new Set<() => void>();
  private removeInputListeners: (() => void) | undefined;
  private ready = false;
  private readyQuietTimer: ReturnType<typeof setTimeout> | undefined;
  private readyMaxTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly readyWaiters = new Set<(ready: boolean) => void>();
  private focusOnOpen: (() => boolean) | null = null;

  constructor(
    private readonly options: TerminalControllerOptions,
    private readonly deps: TerminalControllerDeps,
  ) {
    this.initialize().catch((error: unknown) => {
      if (!this.disposed) {
        const reason = errorReason(error);
        this.term?.write(`\r\n[${i18next.t("common:terminal.init_failed", { reason })}]\r\n`);
      }
    });
  }

  refresh(): void {
    if (this.disposed) return;
    const term = this.term;
    if (!term) return;
    const el = term.element;
    if (el) {
      term.open(el);
    }
    this.runFit();
    term.refresh(0, term.rows - 1);
  }

  focus(wanted: () => boolean = () => true): void {
    if (this.disposed) return;
    if (this.term) this.term.focus();
    else this.focusOnOpen = wanted;
  }

  readText(lines: number, ansi = false): string {
    const buffer = this.term?.buffer.active;
    if (!buffer?.getLine || buffer.length === undefined) return "";
    return ansi ? bufferAnsi(buffer, lines) : bufferText(buffer, lines);
  }

  readScreen(lines: number): AnsiScreen {
    const buffer = this.term?.buffer.active;
    if (!buffer?.getLine || buffer.length === undefined) return { text: "" };
    const { cursorX, cursorY, baseY } = buffer;
    const shown = !this.cursorHidden && cursorX !== undefined && cursorY !== undefined;
    return bufferScreen(
      buffer,
      lines,
      shown ? { row: (baseY ?? 0) + cursorY, cell: cursorX } : null,
    );
  }

  nextOutput(timeoutMs: number): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (shown: boolean) => {
        clearTimeout(timer);
        this.outputWaiters.delete(done);
        resolve(shown);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.outputWaiters.add(done);
    });
  }

  onOutput(listener: (ended: boolean) => void): () => void {
    if (this.disposed) {
      listener(true);
      return () => {};
    }
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  getInputCheckpoint(): TerminalInputCheckpoint {
    return this.inputCheckpoint;
  }

  onInput(listener: () => void): () => void {
    this.inputListeners.add(listener);
    return () => this.inputListeners.delete(listener);
  }

  private noteInput(): void {
    this.cursorBlink?.reset();
    this.inputCheckpoint = { hasInput: true };
    for (const listener of this.inputListeners) listener();
  }

  input(text: string, mode: "paste" | "keys"): boolean {
    const term = this.term;
    const ptyClient = this.ptyClient;
    if (this.disposed || !term || !ptyClient) return false;
    if (text !== "") this.noteInput();
    if (mode === "paste") term.paste(text);
    else ptyClient.write(text);
    return true;
  }

  whenReady(timeoutMs: number): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ready: boolean) => {
        clearTimeout(timer);
        this.readyWaiters.delete(done);
        resolve(ready);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.readyWaiters.add(done);
    });
  }

  private markReady(): void {
    if (this.ready || this.disposed) return;
    this.ready = true;
    clearTimeout(this.readyQuietTimer);
    clearTimeout(this.readyMaxTimer);
    for (const waiter of [...this.readyWaiters]) waiter(true);
  }

  private noteStartingOutput(): void {
    if (this.ready) return;
    clearTimeout(this.readyQuietTimer);
    this.readyQuietTimer = setTimeout(() => this.markReady(), STARTUP_INPUT_QUIET_MS);
  }

  bracketedPaste(): boolean {
    return this.term?.modes.bracketedPasteMode ?? false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.readyQuietTimer);
    clearTimeout(this.readyMaxTimer);
    for (const waiter of [...this.readyWaiters]) waiter(false);
    for (const waiter of [...this.outputWaiters]) waiter(false);
    for (const listener of [...this.outputListeners]) listener(true);
    this.outputListeners.clear();
    this.removeInputListeners?.();
    this.inputListeners.clear();

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

    this.dropDisposable?.();
    this.dropDisposable = null;
    this.pasteDisposable?.();
    this.pasteDisposable = null;

    this.dataDisposable?.dispose();
    this.dataDisposable = null;
    this.selectionDisposable?.dispose();
    this.selectionDisposable = null;
    this.titleDisposable?.dispose();
    this.titleDisposable = null;
    this.altEnterDisposable?.dispose();
    this.altEnterDisposable = null;
    this.altExitDisposable?.dispose();
    this.altExitDisposable = null;
    this.focusReportDisposable?.dispose();
    this.focusReportDisposable = null;
    for (const d of this.cursorDisposables) d.dispose();
    this.cursorDisposables = [];
    this.cursorBlink?.dispose();
    this.cursorBlink = undefined;
    if (this.focusReportTimer !== null) {
      clearTimeout(this.focusReportTimer);
      this.focusReportTimer = null;
    }
    if (this.selectionWriteTimer !== null) {
      clearTimeout(this.selectionWriteTimer);
      this.selectionWriteTimer = null;
    }
    for (const d of this.oscDisposables) d.dispose();
    this.oscDisposables = [];
    this.ptyClient?.dispose();
    this.ptyClient = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.disposeLigatures();
    this.fitAddon?.dispose();
    this.fitAddon = null;
    this.term?.dispose();
    this.term = null;
  }

  get sandboxSession(): string | null {
    return this.disposed ? null : this.sandboxSessionId;
  }

  async reopen(): Promise<void> {
    if (this.disposed) throw new Error("terminal disposed");
    const term = this.term;
    const ptyClient = this.ptyClient;
    if (!term || !ptyClient) throw new Error("terminal unavailable");

    const dimensions = this.currentDimensions();
    const result = await ptyClient.spawn(dimensions);
    if (result === null) return;
    this.noteInput();
    this.noteSpawned(result);
    term.write(`\r\n${TERMINAL_REOPENED_SEPARATOR}\r\n`);
  }

  private noteSpawned(result: SpawnedSession): void {
    this.sandboxSessionId = crypto.randomUUID();
    if (result.missingShell !== undefined) reportMissingShell(result.missingShell);
    if (result.shellPath !== undefined) {
      this.shellPath = result.shellPath;
      this.shellIsPowerShell = /(^|[\\/])(powershell|pwsh)\.exe$/i.test(result.shellPath);
      this.shellTakesHomeEnd = /(^|[\\/])(cmd|powershell|pwsh)\.exe$/i.test(result.shellPath);
    }
  }

  private resolveCurrentThemeId(): ThemeId {
    const attr = document.documentElement.getAttribute("data-theme");
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
    term.options.fontFamily = resolvedTerminalFontFamily();
    this.disposeLigatures();
    if (resolvedTerminalFontLigatures()) {
      void this.loadLigaturesAddon().then((create) => this.applyLigatures(term, create));
    }
    this.runFit();
  }

  private async initialize(): Promise<void> {
    const fontsReady = this.deps.waitForTerminalFonts(resolvedTerminalFontSize());
    let createLigatures: CreateLigaturesAddon | undefined;
    if (resolvedTerminalFontLigatures()) {
      [, createLigatures] = await Promise.all([fontsReady, this.loadLigaturesAddon()]);
    } else {
      await fontsReady;
      if (!this.disposed && resolvedTerminalFontLigatures()) {
        createLigatures = await this.loadLigaturesAddon();
      }
    }
    if (this.disposed) return;

    const initialThemeId = this.resolveCurrentThemeId();

    const term = this.deps.createTerminal({
      cursorBlink: true,
      allowTransparency: true,
      allowProposedApi: true,
      fontFamily: resolvedTerminalFontFamily(),
      fontSize: resolvedTerminalFontSize(),
      cursorStyle: resolvedTerminalCursorStyle(),
      theme: TERMINAL_PALETTES[initialThemeId],
    });
    this.term = term;

    this.themeListener = (e: Event) => {
      const themeId = (e as CustomEvent<{ themeId: ThemeId }>).detail?.themeId;
      if (themeId) this.applyTheme(themeId);
    };
    document.documentElement.addEventListener("nexus:theme-changed", this.themeListener);

    this.terminalSettingsListener = () => {
      this.applyTerminalSettings();
    };
    window.addEventListener("nexus:terminal-settings-changed", this.terminalSettingsListener);

    const fitAddon = this.deps.createFitAddon();
    this.fitAddon = fitAddon;
    term.loadAddon(fitAddon);
    term.open(this.options.container);
    if (term.element && term.textarea) {
      this.cursorBlink = installCursorBlink(term.element, term.textarea);
    }
    if (this.focusOnOpen) {
      const wanted = this.focusOnOpen;
      this.focusOnOpen = null;
      if (wanted()) term.focus();
    }
    this.applyLigatures(term, createLigatures);

    const initialDimensions = this.fitToContainer() ?? { cols: 80, rows: 24 };
    this.lastDims = initialDimensions;

    const ptyClient = this.deps.createPtyClient({
      workspaceId: this.options.workspaceId,
      tabId: this.options.tabId,
      cwd: this.options.cwd,
      shell: this.options.shell,
      ...(this.options.profile !== undefined ? { profile: this.options.profile } : {}),
      onData: (chunk, replay) => {
        this.noteStartingOutput();
        if (!replay) {
          term.write(chunk, () => {
            for (const listener of [...this.outputListeners]) listener(false);
          });
          for (const waiter of [...this.outputWaiters]) waiter(true);
          return;
        }
        this.replayWritesPending += 1;
        term.write(chunk, () => {
          this.replayWritesPending -= 1;
        });
      },
      onExit: (args) => this.options.onExit?.(args),
    });
    this.ptyClient = ptyClient;

    this.dataDisposable = term.onData((data) => {
      if (this.replayWritesPending > 0) return;
      ptyClient.write(data);
    });

    this.installInputTracking();
    this.installFileDrop();
    this.installHeldPaste(term);

    this.titleDisposable = term.onTitleChange((title) => {
      if (this.disposed) return;
      const count = ++this.titleCount;
      const action = classifyOscTitle(title, term.buffer.active.type);
      if (action === "ignore") return;
      if (action === "clear") {
        useTabsStore.getState().setProcessTitle(this.options.workspaceId, this.options.tabId, null);
        return;
      }
      if (action === "apply") {
        useTabsStore
          .getState()
          .setProcessTitle(this.options.workspaceId, this.options.tabId, title);
        return;
      }
      void (async () => {
        const result = await ipcCallResult("pty", "foregroundProcess", {
          workspaceId: this.options.workspaceId,
          tabId: this.options.tabId,
        });
        if (this.disposed || !result.ok || count !== this.titleCount) return;
        if (!foregroundConfirmsTitle(result.value.name)) return;
        useTabsStore
          .getState()
          .setProcessTitle(this.options.workspaceId, this.options.tabId, title);
      })().catch(() => {});
    });

    this.altEnterDisposable = term.parser.registerCsiHandler(
      { prefix: "?", final: "h" },
      (params) => {
        for (const entry of params) {
          if (typeof entry !== "number") continue;
          if (entry === 47 || entry === 1047 || entry === 1049) {
            void (async () => {
              if (this.disposed) return;
              const result = await ipcCallResult("pty", "foregroundProcess", {
                workspaceId: this.options.workspaceId,
                tabId: this.options.tabId,
              });
              if (this.disposed) return;
              if (!result.ok) return;
              const name = result.value.name.trim();
              if (name === "") return;
              useTabsStore
                .getState()
                .setProcessTitle(this.options.workspaceId, this.options.tabId, name);
            })().catch(() => {});
            break;
          }
        }
        return false;
      },
    );

    this.altExitDisposable = term.parser.registerCsiHandler(
      { prefix: "?", final: "l" },
      (params) => {
        for (const entry of params) {
          if (typeof entry !== "number") continue;
          if (entry === 47 || entry === 1047 || entry === 1049) {
            if (!this.disposed) {
              useTabsStore
                .getState()
                .setProcessTitle(this.options.workspaceId, this.options.tabId, null);
            }
            break;
          }
        }
        return false;
      },
    );

    this.cursorHidden = false;
    for (const d of this.cursorDisposables) d.dispose();
    const cursorShown = (shown: boolean) => (params: CsiParamsLike) => {
      if (params.includes(CURSOR_MODE)) this.cursorHidden = !shown;
      return false;
    };
    this.cursorDisposables = [
      term.parser.registerCsiHandler({ prefix: "?", final: "h" }, cursorShown(true)),
      term.parser.registerCsiHandler({ prefix: "?", final: "l" }, cursorShown(false)),
      term.parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => {
        this.cursorHidden = false;
        return false;
      }),
      term.parser.registerEscHandler({ final: "c" }, () => {
        this.cursorHidden = false;
        return false;
      }),
    ];

    this.focusReportDisposable = term.parser.registerCsiHandler(
      { prefix: "?", final: "h" },
      (params) => {
        const listening =
          params.includes(FOCUS_REPORTING_MODE) ||
          (params.includes(BRACKETED_PASTE_MODE) && term.modes.sendFocusMode);
        if (this.replayWritesPending === 0 && listening) {
          if (this.focusReportTimer !== null) clearTimeout(this.focusReportTimer);
          this.focusReportTimer = setTimeout(() => {
            this.focusReportTimer = null;
            if (!this.disposed && term.modes.sendFocusMode && !hasKeyboardFocus(term)) {
              ptyClient.write(FOCUS_OUT_REPORT);
            }
          }, FOCUS_REPORT_DELAY_MS);
        }
        return false;
      },
    );

    this.registerOscHandlers(term);

    this.selectionDisposable = term.onSelectionChange(() => {
      if (this.selectionWriteTimer !== null) clearTimeout(this.selectionWriteTimer);
      this.selectionWriteTimer = setTimeout(() => {
        this.selectionWriteTimer = null;
        if (this.disposed) return;
        const text = term.getSelection();
        if (text) copyTextViaIpc(text);
      }, 50);
    });

    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== "keydown") return true;

      if (event.isComposing && event.keyCode === 91) return false;
      if (event.isComposing || event.keyCode === 229) return true;

      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.defaultPrevented
      ) {
        const { workspaceId, tabId } = this.options;
        const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
        const ended = tab?.type === "terminal" && Boolean(tab.props.dead);
        if (!event.repeat) this.reopenEnterHeld = ended;
        if (ended || this.reopenEnterHeld) {
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) requestTerminalReopen(workspaceId, tabId);
          return false;
        }
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
        const selection = term.getSelection();
        if (selection) {
          copyTextViaIpc(selection);
          if (event.ctrlKey) term.clearSelection();
          event.preventDefault();
          event.stopPropagation();
          return false;
        }
      }

      if (
        event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        event.keyCode === 86 &&
        isWindows()
      ) {
        if (this.shellIsPowerShell && !term.modes.bracketedPasteMode) {
          this.heldPaste = true;
          setTimeout(() => {
            this.heldPaste = false;
          }, 0);
        }
        return false;
      }

      if (event.key === "Enter" && event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        ptyClient.write("\x1b\r");
        return false;
      }

      if (this.shellTakesHomeEnd) return true;
      const isHome =
        (event.key === "Home" &&
          !event.shiftKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey) ||
        (event.key === "ArrowLeft" &&
          event.metaKey &&
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.altKey);
      const isEnd =
        (event.key === "End" &&
          !event.shiftKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey) ||
        (event.key === "ArrowRight" &&
          event.metaKey &&
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.altKey);
      if (isHome || isEnd) {
        event.preventDefault();
        event.stopPropagation();
        const byte = isHome ? "\x01" : "\x05";
        setTimeout(() => ptyClient.write(byte), 0);
        return false;
      }
      return true;
    });

    if (this.options.autoSpawn !== false) {
      ptyClient
        .spawn(initialDimensions)
        .then((result) => {
          if (!result) {
            this.markReady();
            return;
          }
          this.noteSpawned(result);
          this.readyMaxTimer = setTimeout(() => this.markReady(), STARTUP_INPUT_MAX_WAIT_MS);
        })
        .catch((error: unknown) => {
          this.markReady();
          if (!this.disposed) {
            const reason = errorReason(error).replace(AGENT_SPAWN_FAILURE_LEAD, "");
            term.write(`\r\n[${i18next.t("common:terminal.spawn_failed", { reason })}]\r\n`);
          }
        });
    } else {
      this.markReady();
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

  private installInputTracking(): void {
    const container = this.options.container;
    if (typeof container.addEventListener !== "function") return;
    const onInput = (): void => this.noteInput();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (["Alt", "AltGraph", "Control", "Meta", "Shift"].includes(event.key)) return;
      onInput();
    };
    container.addEventListener("keydown", onKeyDown, true);
    container.addEventListener("input", onInput, true);
    container.addEventListener("paste", onInput, true);
    this.removeInputListeners = () => {
      container.removeEventListener("keydown", onKeyDown, true);
      container.removeEventListener("input", onInput, true);
      container.removeEventListener("paste", onInput, true);
    };
  }

  private installFileDrop(): void {
    const el = this.options.container;
    if (typeof el.addEventListener !== "function") return;

    const isFileDrag = (e: DragEvent): boolean =>
      e.dataTransfer != null && Array.from(e.dataTransfer.types).includes("Files");

    const onDragOver = (e: DragEvent): void => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };

    const onDrop = (e: DragEvent): void => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (this.disposed || !e.dataTransfer) return;

      const paths = Array.from(e.dataTransfer.files)
        .map((file) => window.files.getPathForFile(file))
        .filter((p) => p !== "")
        .map((p) => escapeDroppedPath(p, this.shellPath));
      if (paths.length === 0) return;

      this.input(paths.join(" "), "paste");
    };

    el.addEventListener("dragover", onDragOver);
    el.addEventListener("drop", onDrop);
    this.dropDisposable = () => {
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("drop", onDrop);
    };
  }

  private installHeldPaste(term: TerminalLike): void {
    const el = this.options.container;
    if (typeof el.addEventListener !== "function") return;

    const onPaste = (e: ClipboardEvent): void => {
      if (!this.heldPaste) return;
      this.heldPaste = false;
      e.preventDefault();
      e.stopPropagation();
      void this.pasteToFront(term, e.clipboardData?.getData("text/plain") ?? "");
    };

    el.addEventListener("paste", onPaste, true);
    this.pasteDisposable = () => el.removeEventListener("paste", onPaste, true);
  }

  private async pasteToFront(term: TerminalLike, text: string): Promise<void> {
    let name = "";
    try {
      const result = await ipcCallResult("pty", "foregroundProcess", {
        workspaceId: this.options.workspaceId,
        tabId: this.options.tabId,
      });
      if (result.ok) name = result.value.name.trim();
    } catch {}
    if (this.disposed) return;
    if (name === "" || /^(powershell|pwsh)$/i.test(name)) this.ptyClient?.write("\x16");
    else if (text !== "") term.paste(text);
  }

  private registerOscHandlers(term: TerminalLike): void {
    const writeClipboardFromBase64 = (b64: string): void => {
      if (!hasKeyboardFocus(term)) return;
      const text = clipboardTextOf(b64);
      if (text !== null) copyTextViaIpc(text);
    };

    this.oscDisposables.push(
      term.parser.registerOscHandler(52, (data) => {
        const semi = data.indexOf(";");
        if (semi < 0) return true;
        const payload = data.slice(semi + 1);
        if (payload === "" || payload === "?") return true;
        writeClipboardFromBase64(payload);
        return true;
      }),
    );

    this.oscDisposables.push(term.parser.registerOscHandler(7, () => true));

    this.oscDisposables.push(
      term.parser.registerOscHandler(22, (data) => {
        const el = term.element;
        if (el) el.style.cursor = oscCursorStyle(data);
        return true;
      }),
    );

    this.oscDisposables.push(term.parser.registerOscHandler(133, () => true));

    this.oscDisposables.push(
      term.parser.registerOscHandler(1337, (data) => {
        if (data.startsWith("Copy=")) {
          const rest = data.slice("Copy=".length);
          const colon = rest.indexOf(":");
          if (colon >= 0) writeClipboardFromBase64(rest.slice(colon + 1));
        }
        return true;
      }),
    );
  }

  private async loadLigaturesAddon(): Promise<CreateLigaturesAddon | undefined> {
    try {
      return await this.deps.loadLigaturesAddon();
    } catch (error) {
      log.warn(`ligatures addon failed to load: ${errorReason(error)}`);
    }
  }

  private applyLigatures(term: TerminalLike, create: CreateLigaturesAddon | undefined): void {
    if (!create || this.disposed || this.ligaturesAddon || !resolvedTerminalFontLigatures()) return;
    try {
      const addon = create();
      term.loadAddon(addon);
      this.ligaturesAddon = addon;
    } catch (e) {
      log.warn(`ligatures addon failed to activate: ${errorReason(e)}`);
    }
  }

  private disposeLigatures(): void {
    this.ligaturesAddon?.dispose();
    this.ligaturesAddon = null;
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

const AGENT_SPAWN_FAILURE_LEAD = /^failed to spawn PTY: /;

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function bufferText(buffer: BufferLike, lines: number): string {
  const out: string[] = [];
  const length = buffer.length ?? 0;
  for (let y = 0; y < length; y++) {
    const line = buffer.getLine?.(y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && out.length > 0) out[out.length - 1] += text;
    else out.push(text);
  }
  while (out.length > 0 && out[out.length - 1]?.trim() === "") out.pop();
  return out.slice(-lines).join("\n");
}
