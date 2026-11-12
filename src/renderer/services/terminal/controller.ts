import { FitAddon } from "@xterm/addon-fit";
import { LigaturesAddon } from "@xterm/addon-ligatures";
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
import { createPtyClient } from "./pty-client";
import type {
  PtyClient,
  PtyClientOptions,
  SpawnedSession,
  TerminalController,
  TerminalControllerOptions,
  TerminalDimensions,
} from "./types";

const log = createLogger("terminal");

type Disposable = { dispose: () => void };

/** Missing shells already reported this session: one notice each, not one per tab. */
const reportedMissingShells = new Set<string>();

/**
 * Says the chosen shell couldn't be found and the system default opened
 * instead. No name: an added shell that was removed from the settings.
 */
function reportMissingShell(name: string): void {
  if (reportedMissingShells.has(name)) return;
  reportedMissingShells.add(name);
  const message =
    name === ""
      ? i18next.t("common:terminal.shell_removed")
      : i18next.t("common:terminal.shell_missing", { name });
  // Lazy import keeps the controller loadable without the UI layer (tests).
  void import("../../components/ui/toast").then(({ showToast }) =>
    showToast({ kind: "warning", message }),
  );
}

type OscHandlerCallback = (data: string) => boolean | Promise<boolean>;
/**
 * xterm.js v5's public registerCsiHandler API passes the callback a direct array of
 * `(number | number[])[]` rather than an IParams object. Each entry is a single number
 * (an ordinary CSI param) or a number[] (sub-params; when a `:` separator is present).
 *
 * We only need to detect alt-screen enter/exit (`\x1b[?47h/l`, `?1047h/l`, `?1049h/l`) and
 * never use sub-params — so only entries that are numbers are checked and arrays are
 * skipped.
 */
type CsiParamsLike = ReadonlyArray<number | number[]>;
interface ParserLike {
  registerOscHandler: (ident: number, callback: OscHandlerCallback) => Disposable;
  registerCsiHandler: (
    id: { prefix?: string; intermediates?: string; final: string },
    callback: (params: CsiParamsLike) => boolean,
  ) => Disposable;
}

/** The part of xterm's active buffer the controller reads. */
interface BufferLike {
  readonly type: "normal" | "alternate";
  /** Lines in the buffer, scrollback included. */
  readonly length?: number;
  getLine?(
    y: number,
  ): { readonly isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined;
}

interface TerminalLike {
  readonly element?: HTMLElement;
  /** The input that takes the user's keys while the terminal has focus. */
  readonly textarea?: HTMLTextAreaElement;
  readonly rows: number;
  readonly parser: ParserLike;
  /**
   * xterm.js buffer.active.type: "normal" or "alternate".
   * TUIs (claude/lazygit/lazydocker/vim/less/htop) enter the alternate screen at start
   * (\\x1b[?1049h). One-shot commands like ls/grep/cat print on the normal screen.
   * The onTitleChange callback checks this value and accepts a title only in alternate state.
   */
  readonly buffer: { active: BufferLike };
  /**
   * Whether the app on the pty turned on bracketed paste (DECSET 2004) and
   * focus reporting (DECSET 1004).
   */
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
  /**
   * Callback for xterm.js OSC 0/1/2 (window title) sequences. When a TUI such as
   * claude/lazygit/lazydocker sends its name/status as a title sequence, it arrives here.
   */
  onTitleChange: (callback: (title: string) => void) => Disposable;
  getSelection: () => string;
  clearSelection: () => void;
  open: (parent: HTMLElement) => void;
  refresh: (start: number, end: number) => void;
  /** `callback` runs once xterm has parsed `data`. */
  write: (data: string, callback?: () => void) => void;
  /**
   * Inject text as if pasted. Unlike `write`, this respects the terminal app's
   * bracketed paste mode (DECSET 2004): when enabled it wraps the data in
   * `\x1b[200~`/`\x1b[201~` and emits it through `onData`. TUIs such as Claude
   * Code rely on those markers to recognize a dropped file path as a paste unit
   * (and render it as an "[Image]" attachment) rather than as typed keystrokes.
   */
  paste: (data: string) => void;
  attachCustomKeyEventHandler: (handler: (event: KeyboardEvent) => boolean) => void;
  focus: () => void;
}
type FitAddonLike = Pick<FitAddon, "dispose" | "fit" | "proposeDimensions">;
type LigaturesAddonLike = Pick<LigaturesAddon, "dispose">;
type ResizeObserverLike = Pick<ResizeObserver, "disconnect" | "observe">;

export const TERMINAL_REOPENED_SEPARATOR = "─────────────  reopened  ─────────────";

/**
 * Decides whether a title is one a shell prompt fires through OSC 2.
 *
 * bash `PROMPT_COMMAND`, zsh `precmd_functions` and the like fire OSC 2 on every prompt, and
 * the form is almost always `user@host:cwd` or a bare cwd (absolute/home path) — that pattern is filtered out.
 *
 * Rules (judged prompt-like if any one holds):
 *  - the string contains `/` → cwd or path-like (TUIs like lazygit/claude have no slash)
 *  - the string starts with `~` → home-path prompt
 *  - it contains both `@` and `:` → `user@host:` pattern
 *  - A backslash: a Windows path. cmd and PowerShell title the console with
 *    their own path, cmd adding the command it runs.
 *
 * TUIs like lazygit / lazydocker / claude / less are a single word or lack both `:` and `@`,
 * so they pass. With some settings vim can produce titles like "filename (path) - VIM", but
 * such a title likely contains `/` and gets rejected — the user can work around it by
 * setting customTitle directly.
 *
 * exported for unit tests. In production the call path stays inside the controller.
 */
export function isShellPromptLikeTitle(title: string): boolean {
  if (title.includes("/") || title.includes("\\")) return true;
  if (title.startsWith("~")) return true;
  if (title.includes("@") && title.includes(":")) return true;
  return false;
}

// When a login shell is the PTY's foreground process, an OSC title arriving in
// the normal screen buffer is shell-prompt or preexec command-echo noise rather
// than a real inline TUI's title.
export { isLoginShell };

export type OscTitleAction = "ignore" | "apply" | "clear" | "confirm";

/**
 * First-pass classification of an OSC window-title change, by title shape and
 * screen buffer. See the onTitleChange wiring for how each action is handled.
 *
 *  - alternate screen (lazygit/yazi/vim/less): a non-shell-like title applies
 *    directly; a shell-like variant is ignored (the alt-enter foregroundProcess
 *    path labels those tabs instead).
 *  - normal screen: a shell-like title (prompt/path) clears back to the default,
 *    which also resets the tab when an inline TUI like Claude Code exits. A
 *    non-shell-like normal-screen title is deferred to a foregroundProcess
 *    check ("confirm") because preexec hooks can echo commands here.
 */
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

/**
 * Programs that log in to another machine: the titles that come through one
 * are its remote shell's, as the command lines its preexec hook echoes.
 */
const REMOTE_LOGINS: ReadonlySet<string> = new Set([
  "ssh",
  "autossh",
  "mosh",
  "mosh-client",
  "et",
  "telnet",
]);

/**
 * Whether a deferred ("confirm") normal-screen title should apply, given the
 * PTY's current foreground process name. Applies only when a real, non-shell
 * program holds the foreground — so command-echo noise (fired while the shell
 * is still foreground) is rejected. A remote login in front is no such
 * program: what it shows is a remote shell's.
 */
export function foregroundConfirmsTitle(foregroundName: string): boolean {
  const name = foregroundName.trim();
  return name !== "" && !isLoginShell(name) && !REMOTE_LOGINS.has(name.toLowerCase());
}

/** DECSET 1004: the program wants to hear when the terminal gains or loses focus. */
const FOCUS_REPORTING_MODE = 1004;
/** DECSET 2004, bracketed paste: a program setting up for input, as each does when it starts. */
const BRACKETED_PASTE_MODE = 2004;
/**
 * How long after a program asks for focus reports it is told the terminal
 * lacks focus: Codex drops the input that comes while it sets up.
 */
const FOCUS_REPORT_DELAY_MS = 250;
const FOCUS_OUT_REPORT = "\x1b[O";

/** Whether the user's keys reach the terminal: its window has focus and so does its input. */
function hasKeyboardFocus(term: Pick<TerminalLike, "textarea">): boolean {
  return (
    document.hasFocus() && term.textarea !== undefined && document.activeElement === term.textarea
  );
}

/**
 * Quotes a dropped file's path for the terminal's shell, so a path with
 * spaces or shell characters stays one literal argument. `shellPath` is the
 * local shell main reported; a remote terminal has none.
 *
 * - PowerShell: single quotes, with any single quote doubled. Its escape
 *   character is the backtick, so a backslash would not do.
 * - cmd.exe: double quotes, which no Windows file name contains.
 * - Any other shell: backslash escapes, as iTerm2 and Terminal.app drop
 *   paths. Only shell metacharacters and whitespace are escaped, so Unicode
 *   letters (Korean file names) stay as they are and TUIs such as Claude Code
 *   that scan typed input for file paths still recognize the path.
 *
 * A path with nothing to protect is pasted as it is.
 */
export function escapeDroppedPath(path: string, shellPath?: string): string {
  const shell = shellPath?.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (shell === "powershell.exe" || shell === "pwsh.exe" || shell === "pwsh") {
    // PowerShell also takes the typographic single quotes as quotes.
    return /[\s'"`$&(){}[\];,@#|<>‘’‚‛]/.test(path)
      ? `'${path.replace(/['‘’‚‛]/g, "$&$&")}'`
      : path;
  }
  if (shell === "cmd.exe") {
    return /[\s&()[\]{}^=;!'+,`~]/.test(path) ? `"${path}"` : path;
  }
  return path.replace(/[\s'"\\$`(){}[\]<>|&;*?!#~]/g, "\\$&");
}

/** CSS cursor keywords an OSC 22 request may select. */
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

/**
 * The `cursor` style for an OSC 22 body, or "" (reset) for anything that is
 * not a plain keyword. Terminal output is untrusted: assigning it verbatim
 * lets `url(https://…)` make the app's renderer fetch an arbitrary URL.
 *
 * Exported for unit testing.
 */
export function oscCursorStyle(data: string): string {
  const keyword = data.trim().toLowerCase();
  return OSC_CURSOR_KEYWORDS.has(keyword) ? keyword : "";
}

export interface TerminalControllerDeps {
  waitForTerminalFonts: (fontSize: number) => Promise<void>;
  createTerminal: (options: ConstructorParameters<typeof Terminal>[0]) => TerminalLike;
  createFitAddon: () => FitAddonLike;
  createLigaturesAddon: () => LigaturesAddonLike;
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
      document.fonts.load(`${fontSize}px "D2CodingLigature Nerd Font"`),
    ]);
  } catch {
    // Degrade to available metrics rather than blocking the terminal.
  }
}

const defaultTerminalControllerDeps: TerminalControllerDeps = {
  waitForTerminalFonts,
  createTerminal: (options) => new Terminal(options) as unknown as TerminalLike,
  createFitAddon: () => new FitAddon(),
  createLigaturesAddon: () => new LigaturesAddon(),
  createPtyClient,
  createResizeObserver: (callback) => new ResizeObserver(callback),
  requestAnimationFrame: (callback) => requestAnimationFrame(callback),
  cancelAnimationFrame: (handle) => cancelAnimationFrame(handle),
};

class XtermTerminalController implements TerminalController {
  private disposed = false;
  /** The local shell main started, if it said; a remote terminal has none. */
  private shellPath: string | undefined;
  /** Whether the shell is PowerShell, whose PSReadLine pastes on ^V (see the key handler). */
  private shellIsPowerShell = false;
  /** A Ctrl+V whose paste waits until the program in front is known (see installHeldPaste). */
  private heldPaste = false;
  private pasteDisposable: (() => void) | null = null;
  /** Whether the shell is PowerShell or cmd, which read Home and End as they are. */
  private shellTakesHomeEnd = false;
  private term: TerminalLike | null = null;
  private fitAddon: FitAddonLike | null = null;
  private ligaturesAddon: LigaturesAddonLike | null = null;
  private dataDisposable: Disposable | null = null;
  private selectionDisposable: Disposable | null = null;
  private titleDisposable: Disposable | null = null;
  /** Counts the titles the terminal was given, so a deferred one a later title overtook is dropped. */
  private titleCount = 0;
  private altEnterDisposable: Disposable | null = null;
  private altExitDisposable: Disposable | null = null;
  private focusReportDisposable: Disposable | null = null;
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
  /**
   * Replayed chunks xterm has not parsed yet. Replayed output carries the
   * queries (cursor position, device attributes) its program asked when it
   * first ran; xterm answers them again while parsing it, and those answers
   * must not reach the program as input.
   */
  private replayWritesPending = 0;
  /** Who waits for the program's next output; see nextOutput. */
  private readonly outputWaiters = new Set<(shown: boolean) => void>();
  /**
   * Focus asked for before xterm existed: applied once it opens, if what
   * asked for it still wants it then.
   */
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

  focus(wanted: () => boolean = () => true): void {
    if (this.disposed) return;
    if (this.term) this.term.focus();
    else this.focusOnOpen = wanted;
  }

  readText(lines: number): string {
    const buffer = this.term?.buffer.active;
    if (!buffer?.getLine || buffer.length === undefined) return "";
    return bufferText(buffer, lines);
  }

  /**
   * Resolves true when the program next writes output, other than replayed
   * scrollback, or false after `timeoutMs` without any or once the terminal
   * is gone.
   */
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

  input(text: string, mode: "paste" | "keys"): boolean {
    const term = this.term;
    const ptyClient = this.ptyClient;
    if (this.disposed || !term || !ptyClient) return false;
    if (mode === "paste") term.paste(text);
    else ptyClient.write(text);
    return true;
  }

  bracketedPaste(): boolean {
    return this.term?.modes.bracketedPasteMode ?? false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const waiter of [...this.outputWaiters]) waiter(false);

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
    this.noteSpawned(result);
    term.write(`\r\n${TERMINAL_REOPENED_SEPARATOR}\r\n`);
  }

  /** Takes in what main reports about the shell that started. */
  private noteSpawned(result: SpawnedSession): void {
    if (result.missingShell !== undefined) reportMissingShell(result.missingShell);
    if (result.shellPath !== undefined) {
      this.shellPath = result.shellPath;
      this.shellIsPowerShell = /(^|[\\/])(powershell|pwsh)\.exe$/i.test(result.shellPath);
      this.shellTakesHomeEnd = /(^|[\\/])(cmd|powershell|pwsh)\.exe$/i.test(result.shellPath);
    }
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
    term.options.fontFamily = resolvedTerminalFontFamily();
    // Re-evaluate ligatures last. Disposing + re-applying also forces the
    // ligatures addon to recompute font features against the (possibly
    // changed) font family.
    this.disposeLigatures();
    this.applyLigatures(term);
    // Re-fit after font size / family change so column/row counts stay accurate.
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
      // registerCharacterJoiner (used by the ligatures addon) is a *proposed*
      // xterm API — without this flag it throws inside activate() and ligatures
      // silently never render.
      allowProposedApi: true,
      fontFamily: resolvedTerminalFontFamily(),
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
    term.open(this.options.container);
    if (this.focusOnOpen) {
      const wanted = this.focusOnOpen;
      this.focusOnOpen = null;
      if (wanted()) term.focus();
    }
    // Ligatures must be applied AFTER open() — the addon hooks the active
    // (DOM) renderer, which only exists once the terminal is attached.
    this.applyLigatures(term);

    const initialDimensions = this.fitToContainer() ?? { cols: 80, rows: 24 };
    this.lastDims = initialDimensions;

    const ptyClient = this.deps.createPtyClient({
      workspaceId: this.options.workspaceId,
      tabId: this.options.tabId,
      cwd: this.options.cwd,
      shell: this.options.shell,
      onData: (chunk, replay) => {
        if (!replay) {
          term.write(chunk);
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

    // While replayed output is parsed, xterm's answers to its queries are
    // dropped — along with any keystroke in that brief window.
    this.dataDisposable = term.onData((data) => {
      if (this.replayWritesPending > 0) return;
      ptyClient.write(data);
    });

    // External file drop → inject escaped path(s) as a paste. Lets CLIs that
    // accept file paths (Claude Code, image tools, etc.) receive dropped files
    // even though the rest of the app gates DnD to its own internal MIME types.
    this.installFileDrop(term);
    this.installHeldPaste(term);

    // OSC 0/1/2 (window title) — xterm.js's internal parser receives the sequence and
    // exposes it through onTitleChange. The name/status of programs that set the title via
    // OSC — alternate-screen TUIs like lazygit/yazi/vim, and programs like Claude Code that
    // stay on the normal screen — is reflected in the tab's processTitle. If customTitle is set, the displayed title is kept.
    //
    // Noise (the shell prompt's `user@host:cwd`, command echoes from preexec hooks such as
    // starship) must be told apart from real program titles. classifyOscTitle makes a first
    // classification from (title, buffer type):
    //   - "ignore"  : discard
    //   - "apply"   : processTitle = title
    //   - "clear"   : processTitle = null → fall back to defaultTitle/customTitle.
    //                 Shell prompts on the normal screen land here; it also restores the
    //                 tab name naturally when an inline TUI (claude) exits and the prompt returns.
    //   - "confirm" : non-shell-like title on the normal screen (claude etc.). Applied only after
    //                 an RPC confirms the foreground process is the real program → a preexec
    //                 command echo cannot hijack the tab.
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
      // action === "confirm": non-shell-like title on the normal screen. Apply after the foreground check.
      // A title that came after it while the check ran wins: a command that
      // ends at once has its prompt's title clear the tab before the check
      // returns, and its echo must not come back after that.
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
      })().catch(() => {
        // RPC failure is silent — the title is not applied (the existing title stays).
      });
    });

    // On the alt → ENTER transition, fetch the PTY's foreground process name over IPC and
    // apply it as processTitle. TUIs that fire no OSC, such as lazygit / lazydocker / vim /
    // less / htop, are caught this way. Programs like claude that also fire OSC get the OSC path in
    // parallel, and the two results agree (both "claude"), so there is no conflict.
    //
    // One-shot commands like ls/grep/cat run on the normal screen, so this handler is never
    // invoked for them, which guards them naturally.
    //
    // An empty name is the RPC-failure fallback, so the existing title stays — setProcessTitle is not called.
    this.altEnterDisposable = term.parser.registerCsiHandler(
      { prefix: "?", final: "h" },
      (params) => {
        for (const entry of params) {
          if (typeof entry !== "number") continue;
          if (entry === 47 || entry === 1047 || entry === 1049) {
            // fire-and-forget — the CSI handler must return synchronously so xterm.js's parser
            // pipeline is not blocked. The response is applied to the store asynchronously.
            void (async () => {
              if (this.disposed) return;
              const result = await ipcCallResult("pty", "foregroundProcess", {
                workspaceId: this.options.workspaceId,
                tabId: this.options.tabId,
              });
              if (this.disposed) return;
              if (!result.ok) return;
              const name = result.value.name.trim();
              if (name === "") return; // no info — keep the existing title
              useTabsStore
                .getState()
                .setProcessTitle(this.options.workspaceId, this.options.tabId, name);
            })().catch(() => {
              // IPC failure is silent — Claude Code's OSC path can serve as the alternative, or
              // the user can set customTitle directly.
            });
            break;
          }
        }
        return false; // defer to xterm.js's default buffer swap
      },
    );

    // On the alt → normal transition, clear processTitle so the tab falls back naturally to
    // defaultTitle / customTitle. TUIs (claude/lazygit/vim/less) fire one of `\x1b[?47l` /
    // `\x1b[?1047l` / `\x1b[?1049l` on exit. All three variants have prefix="?", final="l",
    // and params[0] of 47/1047/1049. The handler returns false to defer to xterm.js's default
    // buffer swap — we only add a side effect (clearing processTitle).
    //
    // customTitle is preserved (setProcessTitle(null) clears only processTitle).
    this.altExitDisposable = term.parser.registerCsiHandler(
      { prefix: "?", final: "l" },
      (params) => {
        for (const entry of params) {
          // Sub-param (`:` separator) arrays are not used by alt-screen variants — skip.
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
        return false; // proceed with the default xterm.js behavior (buffer swap)
      },
    );

    // A program that turns on focus reporting, as Codex does to tell whether
    // to notify, takes the terminal as focused until told otherwise, and
    // xterm.js reports only changes. One started behind the user's view would
    // never hear it is not looked at, so it is told, a moment after it asks.
    // On Windows the program's request stays inside ConPTY, which turned focus
    // reporting on for the whole session when the shell started, so there the
    // program is told when it sets up for input instead, turning on bracketed
    // paste.
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

    // Drag/keyboard selection → system clipboard (iTerm2 "Copy on selection" default behavior).
    //
    // Sent over the IPC path: the renderer's `navigator.clipboard.writeText` is silently
    // rejected by the Chromium Async Clipboard API when called without user activation.
    // PTY callbacks/selection events have no click context, so they are almost always denied.
    // The main process `electron.clipboard.writeText` (IPC) has no such gate.
    //
    // Debounce: onSelectionChange fires on every mousemove during a drag, flooding IPC.
    // A trailing-edge timer coalesces them into a single write. The timer is kept as an
    // instance field so dispose() can clean it up.
    this.selectionDisposable = term.onSelectionChange(() => {
      if (this.selectionWriteTimer !== null) clearTimeout(this.selectionWriteTimer);
      this.selectionWriteTimer = setTimeout(() => {
        this.selectionWriteTimer = null;
        if (this.disposed) return;
        const text = term.getSelection();
        if (text) copyTextViaIpc(text);
      }, 50);
    });

    // Shift+Enter → ESC + CR ("\x1b\r"). The standard Option/Alt+Enter sequence.
    //
    // Reason: xterm.js's default sends Shift+Enter the same as a plain Enter (CR), so TUIs
    // such as Claude Code do not recognize it as multi-line.
    //
    // ESC+CR was chosen among the candidate sequences:
    //   - "\\\r" (backslash+CR): works on an empty input, but when the text buffer has
    //     content Claude Code fails to recognize the trailing "\" pattern and just
    //     submits. A race in the char-by-char combining step.
    //   - "\x1b\r" (ESC+CR): the standard Option+Enter sequence on macOS. Claude Code
    //     recognizes it as a multi-line signal in an "Option as Meta" setup (official docs).
    //     It also acts as "self-insert-newline" in bash/zsh readline.
    //
    // preventDefault + stopPropagation: handles the case where xterm.js's auxiliary textInput
    // listener additionally leaks Enter's "\r" into onData, causing a race.
    // return false alone does not fully block the textarea's native input path.
    // Cmd+C / Ctrl+C copy-when-selected. iTerm2 / Terminal.app parity.
    //
    // Path:
    //   menu/index.ts unregisters the OS-level accelerator for role:copy, so
    //   ⌘C is not intercepted by Cocoa and reaches this handler as a keydown.
    //
    // Branches:
    //   - With a selection: write to the clipboard over IPC and return false (blocking
    //     xterm's default SIGINT send). Selection → copy completes as one action.
    //   - Without a selection: fall through (return true) — xterm sends ^C to the
    //     PTY as usual, delivering SIGINT to the running process.
    //
    // Both Cmd on macOS and Ctrl on Linux/Windows are accepted. On Linux/Windows Ctrl+C
    // normally expects only SIGINT, but copy taking priority when a selection exists is
    // common behavior across all modern terminals (iTerm2, WezTerm, Windows Terminal).
    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== "keydown") return true;

      // IME composition guard.
      //   While a Korean/Japanese IME is composing in xterm.js's helper textarea,
      //   if this handler calls `preventDefault + stopPropagation` for Shift+Enter /
      //   Cmd+C / Home / End / Cmd+arrow etc., the textarea's composition
      //   state desyncs and Hangul input is duplicated or the same character gets stuck.
      //   During composition every custom mapping is bypassed and xterm.js's default
      //   composition handling takes over. dispatcher.ts has the same guard, running first in
      //   the capture phase, but customKeyEventHandler is called from inside xterm.js through
      //   a separate path, so it must be guarded here too.
      //
      //   The `event.keyCode === 229` fallback covers older Chromium, where `isComposing` is
      //   set late on some keydowns.
      //
      //   Avoiding Mac Cmd+←/→ duplication: macOS has no physical Home/End, so users move to
      //   line start/end with Cmd+←/→. But xterm.js's CompositionHelper.keydown excepts only
      //   keyCode 16/17/18/20/229 and treats Cmd (Meta=91) as a "composition end key",
      //   so pressing Cmd mid-composition commits (sends) the composing character. Then
      //   compositionend finalizes again, and without `_compositionPosition` advancing the
      //   same character is re-sent via setTimeout → the last character is entered twice
      //   ("안녕하세요" + Cmd+← → "요안녕하세요"). Intercepting a bare Meta keydown during
      //   composition here prevents xterm's early finalize, so the composing character is
      //   sent only once through the compositionend path. preventDefault is not called —
      //   touching the textarea's default behavior (cursor movement) would desync the offset
      //   and bring the stuck bug back. (Duplicates in the 4 nav cases were removed, confirmed with a real xterm 6.0.0 replay harness.)
      if (event.isComposing && event.keyCode === 91) return false;
      if (event.isComposing || event.keyCode === 229) return true;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
        const selection = term.getSelection();
        if (selection) {
          copyTextViaIpc(selection);
          // Ctrl+C is also the interrupt key: drop the selection once it's
          // copied, as Windows Terminal does, so the next Ctrl+C reaches the
          // app as ^C instead of copying again. Cmd+C keeps it (iTerm2).
          if (event.ctrlKey) term.clearSelection();
          event.preventDefault();
          event.stopPropagation();
          return false;
        }
        // Without a selection, defer to xterm's default handling so it goes down the SIGINT path.
      }

      // Ctrl+V pastes on Windows, as in Windows Terminal. xterm would send ^V
      // (0x16) instead, which a program reads as a key, not as text: a line
      // prompt such as `claude auth login`'s takes it as a character, and a
      // remote tty as "take the next key as it is". Returning false without
      // preventDefault lets Chromium run its native paste, which xterm sends,
      // bracketed when the program asked: the path Ctrl+Shift+V takes.
      // PowerShell's PSReadLine reads ^V itself and pastes a multi-line
      // clipboard as one edit, where pasted text would run each line. So in a
      // PowerShell terminal, a paste the program did not ask to have
      // bracketed is held until the program in front is known (see
      // installHeldPaste). Matched on keyCode, like xterm's own ^V mapping.
      // Linux keeps ^V and pastes with Ctrl+Shift+V, as its terminals do.
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
          // Chromium pastes within this keydown; a key that pasted nothing lets go.
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

      // Line-begin / line-end → Ctrl+A / Ctrl+E substitution.
      //
      // Background: the input box of the Claude Code TUI (Ink-based) does not map `\x1b[H`/`\x1b[F`
      //   (Home/End normal sequences) to line-begin/end, so Home/End does not work in external
      //   terminals (iTerm2 etc.) either. In our environment, xterm.js additionally goes through the Electron
      //   textarea and Cocoa key bindings intercept the key, so the sequence itself is never sent
      //   to the PTY in some cases (confirmed as no response after `cat -v`).
      //
      // Adopted after measuring how cmux works around the same problem: running `cat -v` in cmux shows
      //   line-begin sent as `^A`(0x01) and line-end as `^E`(0x05). The standard readline key
      //   bindings of Claude Code / bash / zsh all recognize Ctrl+A/E as line-begin/end,
      //   so compatibility is widest.
      //
      // macOS convention:
      //   - Full-size external keyboard: Home / End alone → line-begin / line-end
      //   - Built-in keyboard (no Home/End keys): Cmd+← / Cmd+→ → line-begin / line-end
      //   The browser (Chromium) passes Cmd+arrow through as a KeyboardEvent without any
      //   translation, so both are caught directly and replaced with ^A/^E.
      //
      // Modifier guard:
      //   - Shift+Home/End, Shift+Cmd+arrow: extend selection — pass through.
      //   - Ctrl+Home/End: scrollback buffer top/bottom intent — pass through.
      //   - Alt/Option+arrow: word-jump intent — pass through (Claude Code has its own word-jump).
      //
      // Trade-off: in vim normal mode Ctrl+A means increment number, so there may be
      //   side effects. vim users generally use 0/$/g/G, so this is considered a rare case.
      //   If a compatibility issue is reported, introduce a setting toggle.
      //
      // PowerShell and cmd keep the keys: PowerShell selects the whole line on
      // Ctrl+A and cmd types ^A, while both, and Claude Code under them, move
      // the cursor on Home and End, which ConPTY hands on as key presses.
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
        // Defer the ^A/^E byte to the next macrotask so it lands *after* any
        // pending IME composition commit. When a nav key ends an IME
        // composition, xterm finalizes the composed syllable on a setTimeout(0)
        // scheduled at the preceding `compositionend`; writing our nav byte
        // synchronously here would reach the PTY first and drag the not-yet-sent
        // syllable to the wrong side of the cursor move (e.g. "안녕하세요" +
        // Home → "요안녕하세"). Scheduling our byte on a later setTimeout(0)
        // preserves FIFO ordering: the composed syllable is emitted first, then
        // the cursor moves. This only reorders our own write and never touches
        // xterm's key/composition handling, so it cannot desync the IME state.
        // Works together with the bare-Meta guard above: that guard prevents the
        // Cmd+←/→ double-send, and this defer keeps the single committed syllable
        // ordered before the cursor move.
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
          if (result) this.noteSpawned(result);
        })
        .catch((error: unknown) => {
          if (!this.disposed) {
            const reason = errorReason(error).replace(AGENT_SPAWN_FAILURE_LEAD, "");
            term.write(`\r\n[${i18next.t("common:terminal.spawn_failed", { reason })}]\r\n`);
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

  // ---------------------------------------------------------------------------
  // External file drag-and-drop → PTY
  //
  // The app gates its internal DnD to custom `application/x-nexus-*` MIME types,
  // so OS file drags are ignored everywhere else (and neutralized app-wide by
  // the global guard in bootstrap.ts to prevent file:// navigation). Terminal
  // panes opt back in here: a dropped file's absolute path is escaped and
  // injected via `term.paste()` — NOT `ptyClient.write()`.
  //
  // The paste path matters: it routes through xterm, which honors the app's
  // bracketed paste mode (DECSET 2004) and wraps the text in `\x1b[200~/201~`.
  // TUIs like Claude Code rely on those markers to recognize the path as a
  // dropped file (rendering it as an "[Image]" attachment); a raw pty write
  // arrives as plain keystrokes and leaves the literal "/Users/…" path instead.
  // This mirrors cmux's `ghostty_surface_text` drop path.
  //
  // `stopPropagation()` keeps the event from bubbling to the group-level drop
  // target (which would parse the Files MIME as our custom payload and fail)
  // and to the document-level guard.
  // ---------------------------------------------------------------------------
  private installFileDrop(term: TerminalLike): void {
    const el = this.options.container;
    // Defensive: the container is always a real HTMLElement in production, but
    // unit tests pass a bare stub. Skip wiring when DOM event APIs are absent.
    if (typeof el.addEventListener !== "function") return;

    const isFileDrag = (e: DragEvent): boolean =>
      e.dataTransfer != null && Array.from(e.dataTransfer.types).includes("Files");

    const onDragOver = (e: DragEvent): void => {
      if (!isFileDrag(e)) return;
      // preventDefault is required for the subsequent `drop` event to fire.
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
        // Electron 32+ removed File.path; webUtils (via the preload bridge) is
        // the supported way to recover an absolute path from a dropped File.
        .map((file) => window.files.getPathForFile(file))
        .filter((p) => p !== "")
        .map((p) => escapeDroppedPath(p, this.shellPath));
      if (paths.length === 0) return;

      // No trailing space — paste just the escaped path(s) so Claude Code's
      // image-path detection sees a clean paste unit (matches cmux).
      term.paste(paths.join(" "));
    };

    el.addEventListener("dragover", onDragOver);
    el.addEventListener("drop", onDrop);
    this.dropDisposable = () => {
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("drop", onDrop);
    };
  }

  // ---------------------------------------------------------------------------
  // A held Ctrl+V paste (see the key handler) → PSReadLine's ^V or the text
  //
  // The paste event carries the clipboard's text, as it does for xterm's own
  // paste; the renderer reads the clipboard no other way. PowerShell in front,
  // at its prompt, gets ^V and pastes as before. A program it runs, such as
  // ssh or `claude auth login`, gets the text. When the program in front is
  // not known, ^V is sent, as before. The capture listener on the container
  // runs before xterm's own on its textarea.
  // ---------------------------------------------------------------------------
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
    } catch {
      // Not known: ^V, as before.
    }
    if (this.disposed) return;
    if (name === "" || /^(powershell|pwsh)$/i.test(name)) this.ptyClient?.write("\x16");
    else if (text !== "") term.paste(text);
  }

  // ---------------------------------------------------------------------------
  // OSC handlers — registers commonly used sequences among those iTerm2 supports.
  //
  // xterm.js defaults: 0/1/2 (window title), 4 (palette set), 8 (hyperlink), 10/11/12
  //   (fg/bg/cursor color), 104/110/111/112 (reset). No extra registration needed.
  // Registered by this app: 52, 7, 22, 133, 1337.
  // The notification sequences 9/777/99 are intercepted at PTY chunk level in the main process
  //   (`osc-notification.ts`), so they are not registered again here.
  //
  // Handlers register via `term.parser.registerOscHandler(ident, cb)`. The cb argument data is
  // the body between `ESC ] <ident> ;` and the terminator (BEL or ST). Return true = absorbed, false =
  // pass to the next handler. Unsupported sequences can leak raw escapes onto the screen and corrupt it,
  // so registered handlers always return true.
  // ---------------------------------------------------------------------------
  private registerOscHandlers(term: TerminalLike): void {
    const dispatchCwd = (path: string): void => {
      window.dispatchEvent(
        new CustomEvent("nexus:terminal-cwd", {
          detail: { tabId: this.options.tabId, path },
        }),
      );
    };

    const writeClipboardFromBase64 = (b64: string): void => {
      try {
        // Uses the IPC path: OSC 52 arrives from the PTY data callback, so there is no user
        // activation and `navigator.clipboard.writeText` is rejected.
        //
        // `atob` returns a binary string with one Latin-1 char per byte, so writing it to the
        // clipboard as is turns multi-byte text (Korean etc.) into mojibake
        // ("저" EC A0 80 → "ì \x80"). The OSC 52 payload is the base64 encoding of UTF-8 bytes,
        // so restore a byte array and then UTF-8 decode it.
        const bin = atob(b64);
        const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
        copyTextViaIpc(new TextDecoder().decode(bytes));
      } catch {
        // A base64 decode failure is silently dropped. The shell sent a malformed sequence, so
        // it is not worth giving the user feedback.
      }
    };

    // OSC 52 — set/get clipboard (xterm standard).
    //   `ESC ] 52 ; <targets> ; <base64|?> ST`
    //   targets: c|p|q|s|0..7. A payload of "?" is a read request — not answered for security
    //   (letting an arbitrary TUI read the system clipboard risks leaking passwords etc.).
    //   Used by Claude Code, neovim "+register, tmux set-clipboard, lazygit, etc.
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

    // OSC 7 — current working directory report.
    //   `ESC ] 7 ; file://<host>/<path> ST`
    //   Emitted automatically by zsh chpwd_functions / fish. This app dispatches it as a CustomEvent
    //   so follow-up features such as a new terminal's "Open here" can subscribe.
    this.oscDisposables.push(
      term.parser.registerOscHandler(7, (data) => {
        try {
          const url = new URL(data);
          dispatchCwd(decodeURIComponent(url.pathname));
        } catch {
          // Ignore a malformed URL.
        }
        return true;
      }),
    );

    // OSC 22 — change the mouse cursor shape.
    //   `ESC ] 22 ; <css-cursor-name> ST`  (e.g. "pointer", "text", "default")
    //   An empty string resets to the default.
    this.oscDisposables.push(
      term.parser.registerOscHandler(22, (data) => {
        const el = term.element;
        if (el) el.style.cursor = oscCursorStyle(data);
        return true;
      }),
    );

    // OSC 133 — FinalTerm semantic prompt marks (A=prompt-start, B=command-start,
    //   C=output-start, D=command-end). Shell integration — emitted automatically by Starship/Powerlevel10k.
    //   This app only absorbs it — to keep raw escapes from leaking onto the screen. Extend this hook in
    //   follow-up UX (per-command jumps / selecting the last output).
    this.oscDisposables.push(term.parser.registerOscHandler(133, () => true));

    // OSC 1337 — iTerm2 proprietary. This app handles only SetMark/CurrentDir/Copy.
    //   The rest (File=, SetUserVar, Anchor, Badge, AttentionRequested, Cursor*…)
    //   are only absorbed — the app has no matching feature or they are out of scope.
    this.oscDisposables.push(
      term.parser.registerOscHandler(1337, (data) => {
        if (data === "SetMark") {
          // TODO: store shell-integration marks. Currently only absorbed.
          return true;
        }
        if (data.startsWith("CurrentDir=")) {
          dispatchCwd(data.slice("CurrentDir=".length));
          return true;
        }
        if (data.startsWith("Copy=")) {
          // `Copy=<targets>:<base64>` — targets is ignored (only the system clipboard is used).
          const rest = data.slice("Copy=".length);
          const colon = rest.indexOf(":");
          if (colon >= 0) writeClipboardFromBase64(rest.slice(colon + 1));
          return true;
        }
        return true; // absorb unsupported 1337 subcommands.
      }),
    );
  }

  // Renderer note: we run on xterm's default DOM renderer — NOT Canvas/WebGL.
  // Two reasons:
  //   1. @xterm/addon-ligatures only patches the DOM renderer; under
  //      Canvas/WebGL the addon is a no-op, so ligatures could never render.
  //   2. The DOM renderer composes over the macOS window vibrancy honoring
  //      `allowTransparency` (the same translucency the Canvas renderer was
  //      originally chosen for; WebGL was rejected because it paints an opaque
  //      backdrop).
  // Trade-off: the DOM renderer is less performant than Canvas/WebGL on
  // very high-throughput output, accepted for ligatures + translucency.

  /**
   * Load the ligatures addon when the user has ligatures enabled. No-op when
   * disabled or already loaded. Must be called after term.open().
   */
  private applyLigatures(term: TerminalLike): void {
    if (this.ligaturesAddon) return;
    if (!resolvedTerminalFontLigatures()) return;
    try {
      const addon = this.deps.createLigaturesAddon();
      term.loadAddon(addon as unknown as Disposable);
      this.ligaturesAddon = addon;
    } catch (e) {
      // Don't swallow silently — a failed activate (e.g. missing proposed-API
      // flag) is otherwise invisible and looks like "ligatures just don't work".
      log.warn(`ligatures addon failed to load: ${(e as Error).message}`);
      this.ligaturesAddon = null;
    }
  }

  /** Dispose the ligatures addon if loaded (used on toggle-off and teardown). */
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

/** The agent's lead on a PTY start failure, which the line already says. */
const AGENT_SPAWN_FAILURE_LEAD = /^failed to spawn PTY: /;

/** The message of a failure, without an Error's "Error: " name prefix. */
function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The last `lines` lines of a buffer as plain text, a line the terminal
 * wrapped joined back up, and the empty lines below the last output left out.
 */
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
