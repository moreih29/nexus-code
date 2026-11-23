import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "../../shared/log/types";

export interface StartInfo {
  version: string;
  packaged: boolean;
  platform: string;
  osRelease: string;
  arch: string;
  locale: string;
  electron: string;
  readyMs: number;
}

export function startLine(info: StartInfo): string {
  return (
    `NexusCode started: version=${info.version} packaged=${info.packaged} ` +
    `os=${info.platform} ${info.osRelease} arch=${info.arch} locale=${info.locale} ` +
    `electron=${info.electron} readyMs=${Math.round(info.readyMs)}`
  );
}

export function quitLine(uptimeMs: number, reason?: string): string {
  return `NexusCode quit: uptime=${Math.round(uptimeMs / 1000)}s${reason ? ` (${reason})` : ""}`;
}

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

export function beginRun(
  markerFile: string,
  version: string,
  logger: Pick<Logger, "warn">,
  now: () => number = Date.now,
  markerFs: MarkerFs = realMarkerFs,
): { quit(logger: Pick<Logger, "info">, reason?: string): void } {
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
    } catch {}
    logger.warn(`The previous run ended without a quit line${detail}`);
  }
  try {
    markerFs.write(markerFile, JSON.stringify({ startedAt, version }));
  } catch {}
  let quit = false;
  return {
    quit(out, reason) {
      if (quit) return;
      quit = true;
      out.info(quitLine(now() - startedAt, reason));
      try {
        markerFs.remove(markerFile);
      } catch {}
    },
  };
}
