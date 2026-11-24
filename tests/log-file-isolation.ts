import { mock } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const TEST_LOG_FILE = join(tmpdir(), "nexus-code-tests", "main.log");

type ElectronLogMain = {
  transports: { file: { level: string | false; resolvePathFn: () => string } };
};

const realElectronLogMainPath = join(dirname(require.resolve("electron-log/main")), "src", "main");

const consoleFallback = {
  error: (...a: unknown[]) => console.error(...a),
  warn: (...a: unknown[]) => console.warn(...a),
  info: (...a: unknown[]) => console.info(...a),
  debug: (...a: unknown[]) => console.debug(...a),
};

function loadWithoutFileOutput(): unknown {
  try {
    const loaded = require(realElectronLogMainPath) as ElectronLogMain & {
      default?: ElectronLogMain;
    };
    const log = loaded.default ?? loaded;
    log.transports.file.level = false;
    log.transports.file.resolvePathFn = () => TEST_LOG_FILE;
    return log;
  } catch {
    return consoleFallback;
  }
}

mock.module("electron-log/main", () => ({ default: loadWithoutFileOutput() }));
