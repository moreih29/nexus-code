/**
 * Scopes mock.module to the test file that calls it — loaded as a Bun test
 * preload, after the others.
 *
 * Bun applies mock.module to the module in place and keeps it for the rest of
 * the run, so a file that mocks a module hands its stubs to every test file
 * that runs after it. Which files those are follows the file system's
 * directory order: a suite that passed on macOS failed dozens of tests on
 * Linux, where the files run in another order.
 *
 * The wrapper below snapshots a module's exports before a test file first
 * mocks it, and mocks it back to that snapshot once the file's tests are done.
 * Loading the module for the snapshot also fixes its export names (Bun fixes a
 * mocked module's export names when it first loads), so exports a mock leaves
 * out keep their real values instead of going missing.
 *
 * Only calls made from a test file itself are scoped. The other preloads'
 * mocks (setup.ts, log-test-spies.ts) and those in shared helpers stay for the
 * whole run, as before. A module that cannot be loaded for a snapshot (a
 * native binding built for Electron) is mocked unscoped, as before.
 */

import { afterAll, mock } from "bun:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_FILE = /\.test\.tsx?$/;
const mockModule = mock.module.bind(mock);

/** Modules mocked by the running test file, each with the exports to restore. */
const scoped = new Map<string, Record<string, unknown>>();

/** The file of the first stack frame outside this one. */
function callerFile(): string | undefined {
  for (const line of (new Error().stack ?? "").split("\n").slice(1)) {
    const match = /at (?:.*? \()?(.+?):\d+:\d+\)?$/.exec(line.trim());
    if (match === null) continue;
    const file = match[1].startsWith("file:") ? fileURLToPath(match[1]) : match[1];
    if (file !== import.meta.path) return file;
  }
  return undefined;
}

function snapshot(path: string): Record<string, unknown> | undefined {
  try {
    return { ...import.meta.require(path) };
  } catch {
    return undefined;
  }
}

(mock as { module: typeof mock.module }).module = (specifier, factory) => {
  const file = callerFile();
  if (file === undefined || !TEST_FILE.test(file)) return mockModule(specifier, factory);

  // Resolved against the test file: mock.module would resolve a relative
  // specifier against this preload.
  const path = Bun.resolveSync(specifier, dirname(file));
  if (!scoped.has(path)) {
    const exports = snapshot(path);
    if (exports !== undefined) {
      scoped.set(path, exports);
      afterAll(() => {
        scoped.delete(path);
        mockModule(path, () => exports);
      });
    }
  }
  return mockModule(path, factory);
};
