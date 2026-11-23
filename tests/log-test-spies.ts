import { mock } from "bun:test";
import type { Logger, LogMeta, LogSource } from "../src/shared/log/types";

export const rendererErrorMock = mock((_msg: string, _meta?: LogMeta) => {});
export const rendererWarnMock = mock((_msg: string, _meta?: LogMeta) => {});
export const rendererInfoMock = mock((_msg: string, _meta?: LogMeta) => {});
export const rendererDebugMock = mock((_msg: string, _meta?: LogMeta) => {});

export const mainErrorMock = mock((_msg: string, _meta?: LogMeta) => {});
export const mainWarnMock = mock((_msg: string, _meta?: LogMeta) => {});
export const mainInfoMock = mock((_msg: string, _meta?: LogMeta) => {});
export const mainDebugMock = mock((_msg: string, _meta?: LogMeta) => {});

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
