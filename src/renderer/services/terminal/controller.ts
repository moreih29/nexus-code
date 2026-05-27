import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import type { ITheme } from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import { fontFamily, DEFAULT_THEME, THEMES } from "../../../shared/design-tokens";
import type { ThemeId } from "../../../shared/design-tokens/themes";
import { TERMINAL_PALETTES } from "../../../shared/editor/terminal-palette";
import { resolvedTerminalCursorStyle, resolvedTerminalFontSize } from "../../state/stores/terminal";
import { copyTextViaIpc } from "../../utils/clipboard";
import { createPtyClient } from "./pty-client";
import type {
  PtyClient,
  PtyClientOptions,
  TerminalController,
  TerminalControllerOptions,
  TerminalDimensions,
} from "./types";

type Disposable = { dispose: () => void };

type OscHandlerCallback = (data: string) => boolean | Promise<boolean>;
interface ParserLike {
  registerOscHandler: (ident: number, callback: OscHandlerCallback) => Disposable;
}

type RendererAddon = CanvasAddon | WebglAddon;
interface TerminalLike {
  readonly element?: HTMLElement;
  readonly rows: number;
  readonly parser: ParserLike;
  options: { theme: ITheme | undefined; fontSize: number; cursorStyle: string };
  dispose: () => void;
  loadAddon: (addon: Disposable) => void;
  onData: (callback: (data: string) => void) => Disposable;
  onSelectionChange: (callback: () => void) => Disposable;
  getSelection: () => string;
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
  private selectionDisposable: Disposable | null = null;
  private selectionWriteTimer: ReturnType<typeof setTimeout> | null = null;
  private oscDisposables: Disposable[] = [];
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
    this.selectionDisposable?.dispose();
    this.selectionDisposable = null;
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
