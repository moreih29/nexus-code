import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "../../shared/log/types";

/** What the start line says about the build and the machine. */
export interface StartInfo {
  version: string;
  packaged: boolean;
  platform: string;
  osRelease: string;
  arch: string;
  locale: string;
  electron: string;
  /** Milliseconds from the process start to the app being ready. */
  readyMs: number;
}

export function startLine(info: StartInfo): string {
  return (
    `NexusCode started: version=${info.version} packaged=${info.packaged} ` +
    `os=${info.platform} ${info.osRelease} arch=${info.arch} locale=${info.locale} ` +
    `electron=${info.electron} readyMs=${Math.round(info.readyMs)}`
  );
}

export function quitLine(uptimeMs: number): string {
  return `NexusCode quit: uptime=${Math.round(uptimeMs / 1000)}s`;
}

/** The file system the run marker needs; tests stand in a fake. */
export interface MarkerFs {
  read(file: string): string | null;
  write(file: string, text: string): void;
  remove(file: string): void;
}

export const realMarkerFs: MarkerFs = {
  read(file) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  },
  write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  },
  remove(file) {
    fs.rmSync(file, { force: true });
  },
};

/**
 * Tells whether the run before this one wrote its quit line. The marker is a
 * small file made at start and removed at a clean quit, so one still there at
 * the next start means the last run was cut short: a crash, a kill, a power
 * loss, or a quit that did not reach its end. Nothing is written while the app
 * runs.
 */
export function beginRun(
  markerFile: string,
  version: string,
  logger: Pick<Logger, "warn">,
  now: () => number = Date.now,
  markerFs: MarkerFs = realMarkerFs,
): { quit(logger: Pick<Logger, "info">): void } {
  const startedAt = now();
  const before = markerFs.read(markerFile);
  if (before !== null) {
    let detail = "";
    try {
      const parsed = JSON.parse(before) as { startedAt?: unknown; version?: unknown };
      const started = typeof parsed.startedAt === "number" ? parsed.startedAt : null;
      const ranVersion = typeof parsed.version === "string" ? parsed.version.slice(0, 40) : "";
      if (started !== null)
        detail = ` (started ${new Date(started).toISOString()}, version=${ranVersion})`;
    } catch {
      // A marker that does not parse still says the run was cut short.
    }
    logger.warn(`The previous run ended without a quit line${detail}`);
  }
  try {
    markerFs.write(markerFile, JSON.stringify({ startedAt, version }));
  } catch {
    // A profile that cannot be written to loses only this check.
  }
  return {
    quit(out) {
      out.info(quitLine(now() - startedAt));
      try {
        markerFs.remove(markerFile);
      } catch {
        // Left in place, the next start reports a cut-short run it was not.
      }
    },
  };
}
