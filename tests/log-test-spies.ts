/**
 * Shared log-facade spy setup — loaded as a Bun test preload so that
 * ALL modules evaluated during the test run see the wrapped createLogger.
 *
 * ## Why a preload is required
 *
 * The renderer and main log facades expose `createLogger(source)` which is
 * called at MODULE IMPORT TIME (`const log = createLogger("source")`).  In a
 * single Bun test process (no --isolate), every test file shares the module
 * cache.  The first file to transitively import a module wins the race and
 * fixes its module-level bindings.  Per-file `mock.module` calls that arrive
 * later cannot retroactively change already-evaluated bindings.
 *
 * Running this file as a preload ensures our wrapped `createLogger` is
 * installed before any test module is evaluated, so every call to
 * `createLogger(source)` — regardless of which test file triggered the load —
 * returns a logger that feeds into the exported spy mocks below.
 *
 * ## Why "wrap, not replace"
 *
 * Several tests (error-safety-net.test.ts, window-error-handler.test.ts,
 * surface-error.test.ts) assert on behaviour DEEPER in the logging chain
 * (electron-log transports, logCalls arrays, etc.).  A flat replacement of
 * createLogger with a spy that only records calls would break those tests.
 * The wrapper here calls BOTH the spy AND the original logger method, so:
 *   - Our spy observes the call (for workspace-symbol-registry,
 *     lsp-server-ux-router, and pipe-ready-heartbeat tests).
 *   - The original logger chain still executes (for all other existing tests).
 *
 * ## Usage in test files
 *
 * ```ts
 * const { rendererWarnMock, mainWarnMock } =
 *   await import("../../log-test-spies");
 *
 * beforeEach(() => {
 *   rendererWarnMock.mockClear();
 * });
 *
 * // in test:
 * expect(rendererWarnMock).toHaveBeenCalledTimes(1);
 * ```
 */

import { mock } from "bun:test";
import type { Logger, LogMeta, LogSource } from "../src/shared/log/types";

// ---------------------------------------------------------------------------
// Spy mock functions — exported so test files can assert on them.
// These are the sources of truth for "was the log facade called?".
// ---------------------------------------------------------------------------

export const rendererErrorMock = mock((_msg: string, _meta?: LogMeta) => {});
export const rendererWarnMock = mock((_msg: string, _meta?: LogMeta) => {});
export const rendererInfoMock = mock((_msg: string, _meta?: LogMeta) => {});
export const rendererDebugMock = mock((_msg: string, _meta?: LogMeta) => {});

export const mainErrorMock = mock((_msg: string, _meta?: LogMeta) => {});
export const mainWarnMock = mock((_msg: string, _meta?: LogMeta) => {});
export const mainInfoMock = mock((_msg: string, _meta?: LogMeta) => {});
export const mainDebugMock = mock((_msg: string, _meta?: LogMeta) => {});

// ---------------------------------------------------------------------------
// Renderer facade mock
// ---------------------------------------------------------------------------

// Import the real renderer module BEFORE mock.module replaces it.
// This reference is used to create the original logger that is called through.
const realRendererModule = await import("../src/shared/log/renderer");
const realRendererCreateLogger = realRendererModule.createLogger;

function wrappedRendererCreateLogger(source: LogSource | string): Logger {
  const orig = realRendererCreateLogger(source);
  return {
    error(msg: string, meta?: LogMeta): void {
      rendererErrorMock(msg, meta);
      orig.error(msg, meta);
    },
    warn(msg: string, meta?: LogMeta): void {
      rendererWarnMock(msg, meta);
      orig.warn(msg, meta);
    },
    info(msg: string, meta?: LogMeta): void {
      rendererInfoMock(msg, meta);
      orig.info(msg, meta);
    },
    debug(msg: string, meta?: LogMeta): void {
      rendererDebugMock(msg, meta);
      orig.debug(msg, meta);
    },
  };
}

mock.module("../src/shared/log/renderer", () => ({
  ...realRendererModule,
  createLogger: wrappedRendererCreateLogger,
}));

// ---------------------------------------------------------------------------
// Main-process facade mock
// ---------------------------------------------------------------------------

const realMainModule = await import("../src/shared/log/main");
const realMainCreateLogger = realMainModule.createLogger;

function wrappedMainCreateLogger(source: LogSource | string): Logger {
  const orig = realMainCreateLogger(source);
  return {
    error(msg: string, meta?: LogMeta): void {
      mainErrorMock(msg, meta);
      orig.error(msg, meta);
    },
    warn(msg: string, meta?: LogMeta): void {
      mainWarnMock(msg, meta);
      orig.warn(msg, meta);
    },
    info(msg: string, meta?: LogMeta): void {
      mainInfoMock(msg, meta);
      orig.info(msg, meta);
    },
    debug(msg: string, meta?: LogMeta): void {
      mainDebugMock(msg, meta);
      orig.debug(msg, meta);
    },
  };
}

mock.module("../src/shared/log/main", () => ({
  ...realMainModule,
  createLogger: wrappedMainCreateLogger,
}));
