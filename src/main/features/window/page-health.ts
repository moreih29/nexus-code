/**
 * Keeps an app window's page going past the death of its renderer process,
 * and leaves a trace of how that page was doing.
 *
 * The page runs in a renderer process of its own. When that process dies
 * (out of memory after a long day, a crash) the window has nothing left to
 * paint: on macOS, where the window is transparent, only the traffic lights
 * stay over the desktop, and the app looks gone while it runs on. Terminals,
 * chats and their agents live in the agent processes, not in the page, and
 * outlive it: a page loaded again attaches to them. So a dead page is loaded
 * again at once, with why it died in the log. One that keeps dying is not
 * reloaded in a loop: after a few deaths in a short while the user is asked.
 *
 * The page's memory goes into the log every few minutes, so a page that
 * grows toward its limit shows in the log before it dies.
 */
import type { App, BrowserWindow, MessageBoxOptions, RenderProcessGoneDetails } from "electron";
import { createLogger } from "../../../shared/log/main";

const logger = createLogger("window");

/** How far back the deaths that count toward asking go. */
export const DEATH_WINDOW_MS = 5 * 60_000;
/** Deaths within DEATH_WINDOW_MS after which the page is not reloaded unasked. */
export const DEATHS_BEFORE_ASKING = 3;
/** How often the page's memory goes into the log. */
export const MEMORY_LOG_MS = 10 * 60_000;
/** The share of the JS heap limit past which the memory line is a warning. */
export const HEAP_WARN_SHARE = 0.75;
/** How long the page has to say how big its heap is. */
const HEAP_ANSWER_MS = 5_000;

/** What the question asked about a page that keeps dying says. */
export interface PageDiedText {
  message: string;
  detail: string;
  reload: string;
  quit: string;
}

/**
 * The question asked about a page that keeps dying: load it again, or quit.
 * Quitting ends every terminal and agent, so only its own button does that.
 * Enter loads the page again, and so does closing the question on Windows
 * and Linux (Esc, or the X on its title bar). On macOS, where Enter and Esc
 * are each a button's key and one button holds only one, Esc does nothing:
 * Enter stays on Load Again.
 */
export function pageDiedQuestion(
  text: PageDiedText,
  mac: boolean,
): MessageBoxOptions & { buttons: string[] } {
  return {
    type: "warning",
    message: text.message,
    detail: text.detail,
    buttons: [text.reload, text.quit],
    defaultId: 0,
    cancelId: mac ? -1 : 0,
  };
}

/** Whether an answer to pageDiedQuestion is to load the page again: all but Quit. */
export function reloadsPage(response: number): boolean {
  return response !== 1;
}

/** The window the page lives in: the parts of a BrowserWindow used here. */
export type PageWindow = Pick<BrowserWindow, "isDestroyed" | "on" | "webContents">;

export interface PageHealthDeps {
  /**
   * Asks whether to load a page that keeps dying again; true to load it,
   * false to quit. Without blocking: the main process keeps passing the
   * agents' output along while the question waits.
   */
  askReload(deaths: number): Promise<boolean>;
  quit(): void;
  /** The memory of the app's processes, as app.getAppMetrics() gives it. */
  appMetrics(): ReturnType<App["getAppMetrics"]>;
  now?: () => number;
  setInterval?: (run: () => void, ms: number) => unknown;
  clearInterval?: (timer: unknown) => void;
}

/** Watches `win`'s page: loads it again when it dies, and logs its memory. */
export function watchPageHealth(win: PageWindow, deps: PageHealthDeps): void {
  const now = deps.now ?? Date.now;
  const deaths: number[] = [];

  let asking = false;
  win.webContents.on("render-process-gone", (_event, details: RenderProcessGoneDetails) => {
    // A page that ends cleanly was closed with its window or replaced.
    if (details.reason === "clean-exit" || win.isDestroyed() || asking) return;
    const at = now();
    deaths.push(at);
    while (deaths.length > 0 && (deaths[0] ?? at) <= at - DEATH_WINDOW_MS) deaths.shift();
    const ask = deaths.length >= DEATHS_BEFORE_ASKING;
    logger.error(
      `the window's page died (reason=${details.reason}, exitCode=${details.exitCode}, ` +
        `${deaths.length} in the last ${DEATH_WINDOW_MS / 60_000} min); ` +
        (ask ? "asking whether to load it again" : "loading it again"),
    );
    if (!ask) {
      win.webContents.reload();
      return;
    }
    asking = true;
    void deps
      .askReload(deaths.length)
      .catch(() => true)
      .then((reload) => {
        asking = false;
        if (win.isDestroyed()) return;
        if (reload) win.webContents.reload();
        else deps.quit();
      });
  });

  let unresponsiveAt: number | null = null;
  win.on("unresponsive", () => {
    unresponsiveAt = now();
    logger.warn("the window's page stopped answering");
  });
  win.on("responsive", () => {
    if (unresponsiveAt === null) return;
    const seconds = Math.round((now() - unresponsiveAt) / 1000);
    unresponsiveAt = null;
    logger.info(`the window's page answers again after ${seconds}s`);
  });

  const every = deps.setInterval ?? ((run, ms) => setInterval(run, ms));
  const stop = deps.clearInterval ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
  const timer = every(() => {
    if (win.isDestroyed()) {
      stop(timer);
      return;
    }
    void logPageMemory(win, deps);
  }, MEMORY_LOG_MS);
  win.on("closed", () => stop(timer));
}

interface HeapSize {
  used: number;
  limit: number;
}

/** Logs how much memory the page's process holds and how full its JS heap is. */
export async function logPageMemory(win: PageWindow, deps: PageHealthDeps): Promise<void> {
  const pid = win.webContents.getOSProcessId();
  const metric = deps.appMetrics().find((m) => m.pid === pid);
  if (metric === undefined) return;
  const heap = await heapSize(win);
  if (win.isDestroyed()) return;
  const mb = (kb: number) => Math.round(kb / 1024);
  const parts = [
    `working set ${mb(metric.memory.workingSetSize)} MB`,
    `peak ${mb(metric.memory.peakWorkingSetSize)} MB`,
  ];
  if (heap !== null) {
    parts.push(
      `JS heap ${Math.round(heap.used / 1_048_576)} of ${Math.round(heap.limit / 1_048_576)} MB`,
    );
  }
  const line = `the window's page holds ${parts.join(", ")}`;
  if (heap !== null && heap.used >= heap.limit * HEAP_WARN_SHARE) logger.warn(line);
  else logger.info(line);
}

/** The page's JS heap size, or null when it does not say in time. */
async function heapSize(win: PageWindow): Promise<HeapSize | null> {
  const asked = win.webContents
    .executeJavaScript(
      "(() => { const m = performance.memory; return m ? { used: m.usedJSHeapSize, limit: m.jsHeapSizeLimit } : null; })()",
    )
    .then((answer: unknown) => (isHeapSize(answer) ? answer : null))
    .catch(() => null);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), HEAP_ANSWER_MS);
  });
  try {
    return await Promise.race([asked, late]);
  } finally {
    clearTimeout(timer);
  }
}

function isHeapSize(value: unknown): value is HeapSize {
  if (typeof value !== "object" || value === null) return false;
  const { used, limit } = value as Record<string, unknown>;
  return typeof used === "number" && typeof limit === "number" && limit > 0;
}

/**
 * Logs the app's other processes (GPU, network, utility) that end other than
 * cleanly; Chromium starts most of them again by itself.
 */
export function logChildProcessDeaths(app: Pick<App, "on">): void {
  app.on("child-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    const name = details.name ?? details.serviceName ?? "";
    logger.warn(
      `a ${details.type} process died (reason=${details.reason}, exitCode=${details.exitCode}` +
        `${name ? `, name=${name}` : ""})`,
    );
  });
}
