import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { color, fontFamily, typeScale } from "../../../shared/design-tokens";
import { createPtyClient } from "./pty-client";
import type {
  PtyClient,
  TerminalController,
  TerminalControllerOptions,
  TerminalDimensions,
} from "./types";

type Disposable = { dispose: () => void };

type RendererAddon = CanvasAddon | WebglAddon;

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

class XtermTerminalController implements TerminalController {
  private disposed = false;
  private term: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private rendererAddon: RendererAddon | null = null;
  private dataDisposable: Disposable | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private pendingRaf: number | null = null;
  private lastDims: TerminalDimensions | null = null;
  private ptyClient: PtyClient | null = null;

  constructor(private readonly options: TerminalControllerOptions) {
    this.initialize().catch((error: unknown) => {
      if (!this.disposed) {
        this.term?.write(`\r\n[terminal initialization failed: ${String(error)}]\r\n`);
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.pendingRaf != null) {
      cancelAnimationFrame(this.pendingRaf);
      this.pendingRaf = null;
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

  private async initialize(): Promise<void> {
    const fontSize = typeScale.codeUi.fontSize;
    await waitForTerminalFonts(fontSize);
    if (this.disposed) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: fontFamily.monoDisplay,
      fontSize,
      theme: { background: color.bgCanvas },
    });
    this.term = term;

    const fitAddon = new FitAddon();
    this.fitAddon = fitAddon;
    term.loadAddon(fitAddon);
    this.loadRendererAddon(term);
    term.open(this.options.container);

    const initialDimensions = this.fitToContainer() ?? { cols: 80, rows: 24 };
    this.lastDims = initialDimensions;

    const ptyClient = createPtyClient({
      tabId: this.options.tabId,
      cwd: this.options.cwd,
      onData: (chunk) => term.write(chunk),
      onExit: () => term.write("\r\n[Process exited]\r\n"),
    });
    this.ptyClient = ptyClient;

    this.dataDisposable = term.onData((data) => ptyClient.write(data));
    ptyClient.spawn(initialDimensions).catch((error: unknown) => {
      if (!this.disposed) {
        term.write(`\r\n[spawn failed: ${String(error)}]\r\n`);
      }
    });

    this.resizeObserver = new ResizeObserver(() => {
      if (this.pendingRaf != null) return;
      this.pendingRaf = requestAnimationFrame(() => {
        this.pendingRaf = null;
        this.runFit();
      });
    });
    this.resizeObserver.observe(this.options.container);

    if (this.disposed) this.dispose();
  }

  private loadRendererAddon(term: Terminal): void {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        if (this.disposed || this.term !== term) return;
        const canvas = new CanvasAddon();
        term.loadAddon(canvas);
        this.rendererAddon = canvas;
      });
      term.loadAddon(webgl);
      this.rendererAddon = webgl;
    } catch {
      try {
        const canvas = new CanvasAddon();
        term.loadAddon(canvas);
        this.rendererAddon = canvas;
      } catch {
        this.rendererAddon = null;
      }
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

  private runFit(): void {
    const dimensions = this.fitToContainer();
    if (!dimensions) return;
    if (this.lastDims?.cols === dimensions.cols && this.lastDims.rows === dimensions.rows) return;
    this.lastDims = dimensions;
    this.ptyClient?.resize(dimensions);
  }
}

export function createTerminalController(options: TerminalControllerOptions): TerminalController {
  return new XtermTerminalController(options);
}
