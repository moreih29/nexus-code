import { beforeEach, describe, expect, test } from "bun:test";
import type { App, RenderProcessGoneDetails } from "electron";
import {
  DEATH_WINDOW_MS,
  DEATHS_BEFORE_ASKING,
  logPageMemory,
  MEMORY_LOG_MS,
  type PageHealthDeps,
  type PageWindow,
  watchPageHealth,
} from "../../../../../src/main/features/window/page-health";
import { mainErrorMock, mainInfoMock, mainWarnMock } from "../../../../log-test-spies";

beforeEach(() => {
  mainErrorMock.mockClear();
  mainInfoMock.mockClear();
  mainWarnMock.mockClear();
});

const logged = (m: typeof mainInfoMock) => m.mock.calls.map((c) => String(c[0]));

type Handler = (...args: unknown[]) => void;

/** A window whose page can be made to die, and that counts its reloads. */
function fakeWindow(heap: unknown = { used: 100 * 1_048_576, limit: 4096 * 1_048_576 }) {
  const pageHandlers = new Map<string, Handler>();
  const windowHandlers = new Map<string, Handler>();
  let destroyed = false;
  let reloads = 0;
  const win = {
    isDestroyed: () => destroyed,
    on: (event: string, handler: Handler) => {
      windowHandlers.set(event, handler);
      return win;
    },
    webContents: {
      on: (event: string, handler: Handler) => {
        pageHandlers.set(event, handler);
      },
      reload: () => {
        reloads++;
      },
      getOSProcessId: () => 4242,
      executeJavaScript: async () => heap,
    },
  };
  return {
    win: win as unknown as PageWindow,
    die: (reason: RenderProcessGoneDetails["reason"]) =>
      pageHandlers.get("render-process-gone")?.({}, { reason, exitCode: 5 }),
    emit: (event: string) => windowHandlers.get(event)?.(),
    destroy: () => {
      destroyed = true;
    },
    reloads: () => reloads,
  };
}

function deps(over: Partial<PageHealthDeps> = {}) {
  let clock = 0;
  const asked: number[] = [];
  let quits = 0;
  const timers: Array<() => void> = [];
  const d: PageHealthDeps = {
    askReload: async (deaths) => {
      asked.push(deaths);
      return true;
    },
    quit: () => {
      quits++;
    },
    appMetrics: () =>
      [
        { pid: 4242, memory: { workingSetSize: 900 * 1024, peakWorkingSetSize: 1200 * 1024 } },
      ] as unknown as ReturnType<App["getAppMetrics"]>,
    now: () => clock,
    setInterval: (run, ms) => {
      expect(ms).toBe(MEMORY_LOG_MS);
      timers.push(run);
      return timers.length;
    },
    clearInterval: () => {},
    ...over,
  };
  return {
    d,
    asked,
    quits: () => quits,
    advance: (ms: number) => {
      clock += ms;
    },
    tick: () => {
      for (const run of timers) run();
    },
  };
}

describe("watchPageHealth", () => {
  test("a page that dies is loaded again without asking", () => {
    const w = fakeWindow();
    const s = deps();
    watchPageHealth(w.win, s.d);
    w.die("oom");
    expect(w.reloads()).toBe(1);
    expect(s.asked).toEqual([]);
    expect(logged(mainErrorMock)).toEqual([
      "the window's page died (reason=oom, exitCode=5, 1 in the last 5 min); loading it again",
    ]);
  });

  test("a page that ends cleanly, or dies with its window, is left alone", () => {
    const w = fakeWindow();
    watchPageHealth(w.win, deps().d);
    w.die("clean-exit");
    w.destroy();
    w.die("crashed");
    expect(w.reloads()).toBe(0);
  });

  test("a page that keeps dying is loaded again only when the user says so", async () => {
    const w = fakeWindow();
    const answers: Array<(reload: boolean) => void> = [];
    const s = deps({ askReload: () => new Promise((resolve) => answers.push(resolve)) });
    watchPageHealth(w.win, s.d);
    for (let i = 1; i < DEATHS_BEFORE_ASKING; i++) {
      w.die("crashed");
      s.advance(1_000);
    }
    expect(w.reloads()).toBe(DEATHS_BEFORE_ASKING - 1);

    w.die("crashed");
    expect(logged(mainErrorMock).at(-1)).toBe(
      `the window's page died (reason=crashed, exitCode=5, ${DEATHS_BEFORE_ASKING} in the last 5 min); asking whether to load it again`,
    );
    expect(answers).toHaveLength(1);
    expect(w.reloads()).toBe(DEATHS_BEFORE_ASKING - 1);
    answers[0]?.(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(w.reloads()).toBe(DEATHS_BEFORE_ASKING);

    w.die("crashed");
    answers[1]?.(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(w.reloads()).toBe(DEATHS_BEFORE_ASKING);
    expect(s.quits()).toBe(1);
  });

  test("while the question waits, more deaths ask nothing more", () => {
    const w = fakeWindow();
    let asked = 0;
    const s = deps({
      askReload: () => {
        asked++;
        return new Promise(() => {});
      },
    });
    watchPageHealth(w.win, s.d);
    for (let i = 0; i < DEATHS_BEFORE_ASKING + 2; i++) w.die("crashed");
    expect(asked).toBe(1);
  });

  test("deaths far apart do not add up to asking", () => {
    const w = fakeWindow();
    const s = deps();
    watchPageHealth(w.win, s.d);
    for (let i = 0; i < DEATHS_BEFORE_ASKING * 2; i++) {
      w.die("oom");
      s.advance(DEATH_WINDOW_MS);
    }
    expect(s.asked).toEqual([]);
    expect(w.reloads()).toBe(DEATHS_BEFORE_ASKING * 2);
  });

  test("the page's memory is logged on a timer, and the timer stops with the window", () => {
    const w = fakeWindow();
    let stopped = 0;
    const s = deps({
      clearInterval: () => {
        stopped++;
      },
    });
    watchPageHealth(w.win, s.d);
    s.tick();
    expect(stopped).toBe(0);
    w.destroy();
    s.tick();
    expect(stopped).toBe(1);
  });
});

describe("logPageMemory", () => {
  test("the page's working set and JS heap go into the log", async () => {
    await logPageMemory(fakeWindow().win, deps().d);
    expect(logged(mainInfoMock)).toEqual([
      "the window's page holds working set 900 MB, peak 1200 MB, JS heap 100 of 4096 MB",
    ]);
  });

  test("a heap close to its limit is a warning", async () => {
    const w = fakeWindow({ used: 3500 * 1_048_576, limit: 4096 * 1_048_576 });
    await logPageMemory(w.win, deps().d);
    expect(logged(mainInfoMock)).toEqual([]);
    expect(logged(mainWarnMock)).toEqual([
      "the window's page holds working set 900 MB, peak 1200 MB, JS heap 3500 of 4096 MB",
    ]);
  });

  test("a page that does not say how big its heap is still gets its working set logged", async () => {
    await logPageMemory(fakeWindow(null).win, deps().d);
    expect(logged(mainInfoMock)).toEqual([
      "the window's page holds working set 900 MB, peak 1200 MB",
    ]);
  });

  test("a page whose process is not among the metrics logs nothing", async () => {
    await logPageMemory(fakeWindow().win, deps({ appMetrics: () => [] }).d);
    expect(logged(mainInfoMock)).toEqual([]);
  });
});
