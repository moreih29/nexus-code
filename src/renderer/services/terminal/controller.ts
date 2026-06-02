import { FitAddon } from "@xterm/addon-fit";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import type { ITheme } from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import { DEFAULT_THEME, THEMES } from "../../../shared/design-tokens";
import type { ThemeId } from "../../../shared/design-tokens/themes";
import { TERMINAL_PALETTES } from "../../../shared/editor/terminal-palette";
import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult } from "../../ipc/client";
import { useTabsStore } from "../../state/stores/tabs";
import {
  resolvedTerminalCursorStyle,
  resolvedTerminalFontFamily,
  resolvedTerminalFontLigatures,
  resolvedTerminalFontSize,
} from "../../state/stores/terminal";
import { copyTextViaIpc } from "../../utils/clipboard";
import { createPtyClient } from "./pty-client";
import type {
  PtyClient,
  PtyClientOptions,
  TerminalController,
  TerminalControllerOptions,
  TerminalDimensions,
} from "./types";

const log = createLogger("terminal");

type Disposable = { dispose: () => void };

type OscHandlerCallback = (data: string) => boolean | Promise<boolean>;
/**
 * xterm.js v5의 registerCsiHandler public API는 callback에 IParams 객체가 아닌
 * `(number | number[])[]` 형태의 직접 배열을 넘긴다. 각 entry는 단일 number
 * (보통의 CSI param) 또는 number[] (sub-params; `:` separator가 있는 경우).
 *
 * 우리는 alt-screen 진입/종료(`\x1b[?47h/l`, `?1047h/l`, `?1049h/l`)만 감지하면
 * 되며 sub-params는 사용하지 않는다 — entry가 number일 때만 검사하고 array는
 * skip한다.
 */
type CsiParamsLike = ReadonlyArray<number | number[]>;
interface ParserLike {
  registerOscHandler: (ident: number, callback: OscHandlerCallback) => Disposable;
  registerCsiHandler: (
    id: { prefix?: string; intermediates?: string; final: string },
    callback: (params: CsiParamsLike) => boolean,
  ) => Disposable;
}

interface TerminalLike {
  readonly element?: HTMLElement;
  readonly rows: number;
  readonly parser: ParserLike;
  /**
   * xterm.js의 buffer.active.type. "normal" 또는 "alternate".
   * TUI(claude/lazygit/lazydocker/vim/less/htop)는 시작 시 alternate screen으로
   * 진입한다(\\x1b[?1049h). ls/grep/cat 같은 단발 명령은 normal screen에서 출력.
   * onTitleChange 콜백 시점에 이 값을 확인해 alternate 상태일 때만 title을 수용한다.
   */
  readonly buffer: { active: { type: "normal" | "alternate" } };
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
   * xterm.js의 OSC 0/1/2(window title) 시퀀스 수신 콜백. claude/lazygit/lazydocker
   * 같은 TUI가 자신의 이름/상태를 title 시퀀스로 보내면 여기로 도착한다.
   */
  onTitleChange: (callback: (title: string) => void) => Disposable;
  getSelection: () => string;
  open: (parent: HTMLElement) => void;
  refresh: (start: number, end: number) => void;
  write: (data: string) => void;
  /**
   * Inject text as if pasted. Unlike `write`, this respects the terminal app's
   * bracketed paste mode (DECSET 2004): when enabled it wraps the data in
   * `\x1b[200~`/`\x1b[201~` and emits it through `onData`. TUIs such as Claude
   * Code rely on those markers to recognize a dropped file path as a paste unit
   * (and render it as an "[Image]" attachment) rather than as typed keystrokes.
   */
  paste: (data: string) => void;
  attachCustomKeyEventHandler: (handler: (event: KeyboardEvent) => boolean) => void;
}
type FitAddonLike = Pick<FitAddon, "dispose" | "fit" | "proposeDimensions">;
type LigaturesAddonLike = Pick<LigaturesAddon, "dispose">;
type ResizeObserverLike = Pick<ResizeObserver, "disconnect" | "observe">;

export const TERMINAL_REOPENED_SEPARATOR = "─────────────  reopened  ─────────────";

/**
 * shell prompt가 OSC 2로 발사하는 title인지 판정한다.
 *
 * bash `PROMPT_COMMAND`, zsh `precmd_functions` 등이 매 prompt마다 OSC 2를 발사하는데
 * 형태가 거의 항상 `user@host:cwd` 또는 cwd 단독(절대/홈 경로) — 그 패턴을 거른다.
 *
 * 규칙 (어느 하나라도 충족 시 prompt-like로 판정):
 *  - 문자열에 `/`가 포함 → cwd 또는 path-like (lazygit/claude 같은 TUI는 슬래시 없음)
 *  - 문자열이 `~`로 시작 → 홈 경로 prompt
 *  - `@`와 `:`가 동시에 포함 → `user@host:` 패턴
 *
 * lazygit / lazydocker / claude / less 같은 TUI는 단일 단어이거나 `:` / `@`를 함께
 * 갖지 않으므로 통과한다. vim의 경우 일부 setting에서 "filename (path) - VIM" 같은
 * 형태가 가능하지만 그런 경우 `/`가 들어가 거부될 가능성 — 사용자가 customTitle로
 * 직접 지정하는 경로로 대체 가능.
 *
 * exported는 단위 테스트용. production 호출 경로는 controller 내부.
 */
export function isShellPromptLikeTitle(title: string): boolean {
  if (title.includes("/")) return true;
  if (title.startsWith("~")) return true;
  if (title.includes("@") && title.includes(":")) return true;
  return false;
}

/**
 * Login-shell program names. When one of these is the PTY's foreground process,
 * an OSC title arriving in the normal screen buffer is shell-prompt or preexec
 * command-echo noise rather than a real inline TUI's title.
 *
 * `ps -o comm=` may prefix a login shell with "-" (e.g. "-zsh"); we strip it.
 */
const LOGIN_SHELL_NAMES: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "tcsh",
  "csh",
]);

/** True when `comm` (a `ps -o comm=` basename) names a login shell. */
export function isLoginShell(comm: string): boolean {
  return LOGIN_SHELL_NAMES.has(comm.trim().replace(/^-/, ""));
}

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
 * Whether a deferred ("confirm") normal-screen title should apply, given the
 * PTY's current foreground process name. Applies only when a real, non-shell
 * program holds the foreground — so command-echo noise (fired while the shell
 * is still foreground) is rejected.
 */
export function foregroundConfirmsTitle(foregroundName: string): boolean {
  const name = foregroundName.trim();
  return name !== "" && !isLoginShell(name);
}

/**
 * Backslash-escape a filesystem path for injection into a shell / TUI prompt,
 * matching the drag-and-drop behavior of iTerm2 and Terminal.app.
 *
 * Only POSIX shell metacharacters and whitespace are escaped — Unicode letters
 * (e.g. Korean filenames) are deliberately left intact, so a denylist (escape
 * these specific bytes) is used rather than an allowlist. The result stays a
 * single argument while remaining recognizable as a literal path to TUIs such
 * as Claude Code that scan typed input for file paths.
 *
 * Exported for unit testing.
 */
export function escapeDroppedPath(path: string): string {
  // Order matters only in that the backslash class member escapes itself; the
  // regex matches one metacharacter at a time and prefixes it with a backslash.
  return path.replace(/[\s'"\\$`(){}[\]<>|&;*?!#~]/g, "\\$&");
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
  private term: TerminalLike | null = null;
  private fitAddon: FitAddonLike | null = null;
  private ligaturesAddon: LigaturesAddonLike | null = null;
  private dataDisposable: Disposable | null = null;
  private selectionDisposable: Disposable | null = null;
  private titleDisposable: Disposable | null = null;
  private altEnterDisposable: Disposable | null = null;
  private altExitDisposable: Disposable | null = null;
  private selectionWriteTimer: ReturnType<typeof setTimeout> | null = null;
  private oscDisposables: Disposable[] = [];
  private resizeObserver: ResizeObserverLike | null = null;
  private pendingRaf: number | null = null;
  private lastDims: TerminalDimensions | null = null;
  private ptyClient: PtyClient | null = null;
  private themeListener: ((e: Event) => void) | null = null;
  private terminalSettingsListener: ((e: Event) => void) | null = null;
  private dropDisposable: (() => void) | null = null;

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

    this.dropDisposable?.();
    this.dropDisposable = null;

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
    // Ligatures must be applied AFTER open() — the addon hooks the active
    // (DOM) renderer, which only exists once the terminal is attached.
    this.applyLigatures(term);

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

    // External file drop → inject escaped path(s) as a paste. Lets CLIs that
    // accept file paths (Claude Code, image tools, etc.) receive dropped files
    // even though the rest of the app gates DnD to its own internal MIME types.
    this.installFileDrop(term);

    // OSC 0/1/2(window title) — xterm.js 내부 파서가 시퀀스를 수신해 onTitleChange로
    // 노출한다. lazygit/yazi/vim 같은 alternate-screen TUI, 그리고 Claude Code처럼
    // alternate에 들어가지 않고 일반 화면에서 OSC로 제목을 쏘는 프로그램의 이름/상태를
    // 탭의 processTitle로 반영한다. customTitle이 설정돼 있으면 표시 title은 유지된다.
    //
    // 노이즈(셸 프롬프트의 `user@host:cwd`, starship 등 preexec hook의 명령 에코)와
    // 실제 프로그램 제목을 구분해야 한다. classifyOscTitle이 (title, buffer type)으로
    // 1차 분류한다:
    //   - "ignore"  : 버림
    //   - "apply"   : processTitle = title
    //   - "clear"   : processTitle = null → defaultTitle/customTitle 복귀.
    //                 normal screen의 셸 프롬프트가 여기 해당하며, inline TUI(claude)가
    //                 종료돼 프롬프트가 돌아올 때 탭 이름을 자연스럽게 되돌리는 역할도 한다.
    //   - "confirm" : normal screen의 비셸틱 제목(claude 등). foreground process가 실제
    //                 프로그램인지 RPC로 확인한 뒤에만 적용 → preexec 명령 에코가 탭을
    //                 가로채지 못한다.
    this.titleDisposable = term.onTitleChange((title) => {
      if (this.disposed) return;
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
      // action === "confirm": normal-screen 비셸틱 제목. foreground 확인 후 적용.
      void (async () => {
        const result = await ipcCallResult("pty", "foregroundProcess", {
          workspaceId: this.options.workspaceId,
          tabId: this.options.tabId,
        });
        if (this.disposed || !result.ok) return;
        if (!foregroundConfirmsTitle(result.value.name)) return;
        useTabsStore
          .getState()
          .setProcessTitle(this.options.workspaceId, this.options.tabId, title);
      })().catch(() => {
        // RPC 실패는 silent — 제목 미적용(기존 title 유지).
      });
    });

    // alt → ENTER 전이 시 PTY의 foreground process 이름을 IPC로 가져와 processTitle로
    // 적용한다. lazygit / lazydocker / vim / less / htop처럼 OSC를 발사하지 않는 TUI도
    // 이 경로로 잡힌다. claude처럼 OSC도 발사하는 프로그램은 OSC 경로가 병행 적용되며
    // 두 결과가 일치(둘 다 "claude")하므로 충돌 없음.
    //
    // ls/grep/cat 같은 단발 명령은 normal screen에서 실행되므로 이 핸들러 자체가
    // 호출되지 않아 자연스럽게 가드.
    //
    // 빈 이름은 RPC 실패 fallback이므로 기존 title 유지 — setProcessTitle 호출 안 함.
    this.altEnterDisposable = term.parser.registerCsiHandler(
      { prefix: "?", final: "h" },
      (params) => {
        for (const entry of params) {
          if (typeof entry !== "number") continue;
          if (entry === 47 || entry === 1047 || entry === 1049) {
            // fire-and-forget — CSI handler는 동기 반환해야 xterm.js의 parser
            // pipeline이 블록되지 않는다. 응답은 비동기로 store에 반영.
            void (async () => {
              if (this.disposed) return;
              const result = await ipcCallResult("pty", "foregroundProcess", {
                workspaceId: this.options.workspaceId,
                tabId: this.options.tabId,
              });
              if (this.disposed) return;
              if (!result.ok) return;
              const name = result.value.name.trim();
              if (name === "") return; // 정보 없음 — 기존 title 유지
              useTabsStore
                .getState()
                .setProcessTitle(this.options.workspaceId, this.options.tabId, name);
            })().catch(() => {
              // ipc 실패는 silent — Claude Code의 OSC 경로가 대안으로 작동하거나
              // 사용자가 customTitle로 직접 지정 가능.
            });
            break;
          }
        }
        return false; // xterm.js 기본 buffer swap에 위임
      },
    );

    // alt → normal 전이 시 processTitle을 clear해 defaultTitle / customTitle로
    // 자연 복귀. TUI(claude/lazygit/vim/less)는 종료 시 `\x1b[?47l` / `\x1b[?1047l`
    // / `\x1b[?1049l` 중 하나를 발사한다. 세 변형 모두 prefix="?", final="l"이며
    // params[0]가 47/1047/1049. handler는 return false로 xterm.js 기본 buffer
    // swap 동작에 위임한다 — 우리는 부수효과(processTitle clear)만 추가.
    //
    // customTitle은 보존된다 (setProcessTitle(null)은 processTitle만 clear).
    this.altExitDisposable = term.parser.registerCsiHandler(
      { prefix: "?", final: "l" },
      (params) => {
        for (const entry of params) {
          // sub-params(`:` separator) array는 alt-screen 변형에서 사용되지 않음 — skip.
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
        return false; // 기본 xterm.js 동작(buffer swap) 그대로 진행
      },
    );

    this.registerOscHandlers(term);

    // 드래그/키보드 셀렉션 → 시스템 클립보드 (iTerm2 "Copy on selection" 기본 동작).
    //
    // IPC 경로로 보냄: renderer 의 `navigator.clipboard.writeText` 는 user
    // activation 없이 호출하면 Chromium Async Clipboard API 가 silent reject.
    // PTY 콜백/selection 이벤트는 클릭 컨텍스트가 없어서 거의 항상 거부됨.
    // main process `electron.clipboard.writeText` (IPC) 는 게이트 없음.
    //
    // Debounce: drag 중 mousemove 마다 onSelectionChange 가 발사되어 IPC 가
    // flooding. trailing-edge timer 로 합쳐 한 번만 쓰도록 한다. 타이머는
    // 인스턴스 필드로 보관해 dispose() 에서 정리 가능.
    this.selectionDisposable = term.onSelectionChange(() => {
      if (this.selectionWriteTimer !== null) clearTimeout(this.selectionWriteTimer);
      this.selectionWriteTimer = setTimeout(() => {
        this.selectionWriteTimer = null;
        if (this.disposed) return;
        const text = term.getSelection();
        if (text) copyTextViaIpc(text);
      }, 50);
    });

    // Shift+Enter → ESC + CR ("\x1b\r"). Option/Alt+Enter 표준 시퀀스.
    //
    // 이유: xterm.js 의 기본 동작은 Shift+Enter 를 일반 Enter (CR) 와 동일하게
    // 보내 Claude Code 등 TUI 가 multi-line 으로 인식 못한다.
    //
    // 후보 시퀀스 중 ESC+CR 을 선택:
    //   - "\\\r" (backslash+CR): 빈 input 에서는 작동하나, 텍스트 buffer 가
    //     있는 상태에서 Claude Code 가 마지막 "\" 패턴을 인식하지 못하고 그대로
    //     submit 처리. char-by-char 단계 결합에서 race.
    //   - "\x1b\r" (ESC+CR): macOS 의 Option+Enter 표준 시퀀스. Claude Code 가
    //     "Option as Meta" 설정 환경에서 multi-line 신호로 인식 (공식 docs).
    //     bash/zsh readline 에서도 ESC+CR 은 "self-insert-newline" 으로 동작.
    //
    // preventDefault + stopPropagation: xterm.js 의 textInput 보조 listener 가
    // Enter 의 "\r" 를 추가로 onData 에 흘려보내 race 가 발생하는 케이스 대응.
    // return false 만으론 textarea 의 native input 경로를 완전히 차단하지 못함.
    // Cmd+C / Ctrl+C copy-when-selected. iTerm2 / Terminal.app parity.
    //
    // 경로:
    //   menu/index.ts 에서 role:copy 의 OS-level accelerator 등록을 해제했으므로
    //   ⌘C 가 Cocoa 에 가로채이지 않고 keydown 으로 이 핸들러까지 도달한다.
    //
    // 분기:
    //   - 셀렉션 있으면: IPC 클립보드로 쓰고 return false (xterm 의 기본 SIGINT
    //     송신을 차단). 셀렉션 → 복사 한 동작으로 완결.
    //   - 셀렉션 없으면: fall through (return true) — xterm 이 평소대로 ^C 를
    //     PTY 로 보내서 실행 중 프로세스에 SIGINT 전달.
    //
    // macOS 의 Cmd, Linux/Windows 의 Ctrl 둘 다 인정. Linux/Windows 에서 Ctrl+C
    // 는 보통 SIGINT 만 기대하지만, 셀렉션이 있을 때 복사 우선은 모든 모던
    // 터미널(iTerm2, WezTerm, Windows Terminal) 공통 동작.
    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== "keydown") return true;

      // IME composition guard.
      //   한국어/일본어 IME가 xterm.js의 helper textarea에서 합성 중일 때,
      //   본 핸들러가 Shift+Enter / Cmd+C / Home / End / Cmd+arrow 등에 대해
      //   `preventDefault + stopPropagation`을 호출하면 textarea의 composition
      //   state가 desync되어 한글 입력이 중복되거나 같은 글자가 stuck된다.
      //   합성 중에는 모든 사용자 정의 매핑을 우회하고 xterm.js의 기본
      //   composition 처리에 위임한다. dispatcher.ts에 동일한 가드가 capture
      //   phase에서 먼저 동작하지만, customKeyEventHandler는 xterm.js 내부에서
      //   별도 경로로 호출되므로 여기서도 가드해야 안전하다.
      //
      //   `event.keyCode === 229` fallback은 옛 Chromium에서 `isComposing`이
      //   일부 keydown에 늦게 세팅되는 케이스 대응.
      if (event.isComposing || event.keyCode === 229) return true;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
        const selection = term.getSelection();
        if (selection) {
          copyTextViaIpc(selection);
          event.preventDefault();
          event.stopPropagation();
          return false;
        }
        // 셀렉션 없으면 SIGINT 경로로 보내기 위해 xterm 기본 처리에 위임.
      }

      if (event.key === "Enter" && event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        ptyClient.write("\x1b\r");
        return false;
      }

      // Line-begin / line-end → Ctrl+A / Ctrl+E 치환.
      //
      // 배경: Claude Code TUI(Ink 기반)의 입력 박스는 `\x1b[H`/`\x1b[F`(Home/End
      //   normal sequence)를 line-begin/end로 매핑하지 않아 외부 터미널(iTerm2 등)
      //   에서도 Home/End가 안 먹는다. 우리 환경에선 추가로 xterm.js가 Electron
      //   textarea를 거치며 Cocoa 키바인딩에 가로채여 PTY로 시퀀스 자체를 전송하지
      //   않는 케이스가 관찰됐다 (`cat -v` 후 무반응으로 확인).
      //
      // cmux가 동일 문제를 우회하는 방식을 실측해 채택: cmux에서 `cat -v`를 실행하면
      //   line-begin은 `^A`(0x01), line-end는 `^E`(0x05)로 송신된다. Claude Code /
      //   bash / zsh의 readline 표준 키바인딩이 모두 Ctrl+A/E를 line-begin/end로
      //   인식하므로 호환성이 가장 넓다.
      //
      // macOS 컨벤션:
      //   - 풀사이즈 외장 키보드: Home / End 키 단독 → line-begin / line-end
      //   - 내장 키보드(Home/End 키 없음): Cmd+← / Cmd+→ → line-begin / line-end
      //   브라우저(Chromium)는 Cmd+arrow를 별도 변환 없이 KeyboardEvent로 그대로
      //   전달하므로 양쪽 모두 직접 잡아 ^A/^E로 치환한다.
      //
      // modifier 가드:
      //   - Shift+Home/End, Shift+Cmd+arrow: selection 확장 — 통과.
      //   - Ctrl+Home/End: 스크롤백 buffer top/bottom 의도 — 통과.
      //   - Alt/Option+arrow: word-jump 의도 — 통과 (Claude Code도 자체 word-jump 사용).
      //
      // Trade-off: vim normal mode에서 Ctrl+A는 increment number 의미라
      //   부작용 가능. vim 사용자는 0/$/g/G를 쓰는 것이 일반적이라 드문 케이스로
      //   간주한다. 향후 호환성 이슈 보고 시 setting 토글 도입.
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
        ptyClient.write(isHome ? "\x01" : "\x05");
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
        .map((p) => escapeDroppedPath(p));
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
  // OSC handlers — iTerm2 가 지원하는 시퀀스 중 자주 쓰이는 항목 등록.
  //
  // xterm.js 기본: 0/1/2 (창 제목), 4 (팔레트 set), 8 (하이퍼링크), 10/11/12
  //   (fg/bg/cursor color), 104/110/111/112 (리셋). 추가 등록 불필요.
  // 본 앱 등록: 52, 7, 22, 133, 1337.
  // 알림용 9/777/99 는 main process(`osc-notification.ts`)에서 PTY chunk 레벨로
  //   인터셉트되므로 여기서 다시 등록하지 않는다.
  //
  // 핸들러는 `term.parser.registerOscHandler(ident, cb)` 로 등록. cb 인자 data 는
  // `ESC ] <ident> ;` 와 종결자(BEL 또는 ST) 사이의 본문. 반환 true=흡수, false=
  // 다음 핸들러로 패스. 미지원 시퀀스는 raw escape 가 화면에 새어 깨질 수 있어,
  // 등록 핸들러는 항상 true 반환.
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
        // IPC 경로 사용: OSC 52 는 PTY 데이터 콜백에서 도달하므로 user
        // activation 이 없어 `navigator.clipboard.writeText` 가 거부된다.
        copyTextViaIpc(atob(b64));
      } catch {
        // base64 디코드 실패는 silently drop. 셸이 잘못된 시퀀스를 보낸 경우라
        // 사용자에게 피드백 줄 가치 없음.
      }
    };

    // OSC 52 — set/get clipboard (xterm 표준).
    //   `ESC ] 52 ; <targets> ; <base64|?> ST`
    //   targets: c|p|q|s|0..7. payload "?" 는 read 요청 — 보안상 응답 안 함
    //   (시스템 클립보드를 임의 TUI 가 읽도록 허용하면 비밀번호 등 탈취 위험).
    //   Claude Code, neovim "+register, tmux set-clipboard, lazygit 등이 사용.
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

    // OSC 7 — current working directory 보고.
    //   `ESC ] 7 ; file://<host>/<path> ST`
    //   zsh chpwd_functions / fish 가 자동 emit. 본 앱은 CustomEvent 로 디스패치
    //   해 새 터미널 "Open here" 등 후속 기능이 구독 가능하도록.
    this.oscDisposables.push(
      term.parser.registerOscHandler(7, (data) => {
        try {
          const url = new URL(data);
          dispatchCwd(decodeURIComponent(url.pathname));
        } catch {
          // 잘못된 URL 형식 무시.
        }
        return true;
      }),
    );

    // OSC 22 — 마우스 커서 모양 변경.
    //   `ESC ] 22 ; <css-cursor-name> ST`  (e.g. "pointer", "text", "default")
    //   빈 문자열은 기본값으로 리셋.
    this.oscDisposables.push(
      term.parser.registerOscHandler(22, (data) => {
        const el = term.element;
        if (el) el.style.cursor = data || "";
        return true;
      }),
    );

    // OSC 133 — FinalTerm semantic prompt marks (A=prompt-start, B=command-start,
    //   C=output-start, D=command-end). 셸 통합 — Starship/Powerlevel10k 가 자동
    //   emit. 본 앱은 흡수만 — raw escape 가 화면에 새는 것 방지. 후속 UX(명령
    //   단위 점프/마지막 출력 선택)에서 이 hook 을 확장.
    this.oscDisposables.push(term.parser.registerOscHandler(133, () => true));

    // OSC 1337 — iTerm2 proprietary. 본 앱은 SetMark/CurrentDir/Copy 3개만 동작.
    //   나머지(File=, SetUserVar, Anchor, Badge, AttentionRequested, Cursor*…)
    //   는 흡수만 — 본 앱에 대응 기능 없거나 스코프 밖.
    this.oscDisposables.push(
      term.parser.registerOscHandler(1337, (data) => {
        if (data === "SetMark") {
          // TODO: 셸 통합 마크 저장. 현재는 흡수만.
          return true;
        }
        if (data.startsWith("CurrentDir=")) {
          dispatchCwd(data.slice("CurrentDir=".length));
          return true;
        }
        if (data.startsWith("Copy=")) {
          // `Copy=<targets>:<base64>` — targets 는 무시(시스템 클립보드만 사용).
          const rest = data.slice("Copy=".length);
          const colon = rest.indexOf(":");
          if (colon >= 0) writeClipboardFromBase64(rest.slice(colon + 1));
          return true;
        }
        return true; // 미지원 1337 서브커맨드 흡수.
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
