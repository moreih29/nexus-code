/**
 * Process-level resolver for the system Git binary. The resolver keeps a
 * singleton promise so every repository shares the same detection result.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitBinary {
  readonly path: string;
  readonly version: string;
}

let cachedKey: string | null = null;
let cachedResult: Promise<GitBinary | null> | null = null;

/**
 * Resolves the system git executable without throwing when git is absent.
 */
export function resolveGitBinary(gitPathOverride?: string | null): Promise<GitBinary | null> {
  const cacheKey = normalizeOverride(gitPathOverride) ?? "";
  if (cachedResult && cachedKey === cacheKey) return cachedResult;

  cachedKey = cacheKey;
  cachedResult = resolveGitBinaryUncached(cacheKey.length > 0 ? cacheKey : null);
  return cachedResult;
}

/**
 * Runs the resolver steps in priority order: override, PATH lookup, fallback.
 */
async function resolveGitBinaryUncached(gitPathOverride: string | null): Promise<GitBinary | null> {
  const candidates = new Set<string>();

  if (gitPathOverride) candidates.add(gitPathOverride);

  for (const pathFromLocator of await locateGitOnPath()) {
    candidates.add(pathFromLocator);
  }

  if (process.platform !== "win32") {
    candidates.add("/usr/bin/git");
  }

  for (const candidate of candidates) {
    const resolved = await inspectGitBinary(candidate);
    if (resolved) return resolved;
  }

  return null;
}

/**
 * Uses the platform locator command to find git on PATH.
 */
async function locateGitOnPath(): Promise<string[]> {
  const command = process.platform === "win32" ? "where" : "which";

  try {
    const { stdout } = await execFileAsync(command, ["git"], { encoding: "utf8" });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/**
 * Verifies that a candidate path runs and reports a git version string.
 */
async function inspectGitBinary(candidatePath: string): Promise<GitBinary | null> {
  try {
    const { stdout } = await execFileAsync(candidatePath, ["--version"], {
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const version = parseGitVersion(stdout);
    return version ? { path: candidatePath, version } : null;
  } catch {
    return null;
  }
}

/**
 * Extracts the version detail from the standard `git --version` banner.
 */
function parseGitVersion(stdout: string): string | null {
  const line = stdout.trim().split(/\r?\n/, 1)[0] ?? "";
  const prefix = "git version ";
  if (!line.toLowerCase().startsWith(prefix)) return null;
  const version = line.slice(prefix.length).trim();
  return version.length > 0 ? version : null;
}

/**
 * Normalizes empty override values so the cache key stays stable.
 */
function normalizeOverride(gitPathOverride?: string | null): string | null {
  const trimmed = gitPathOverride?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}
