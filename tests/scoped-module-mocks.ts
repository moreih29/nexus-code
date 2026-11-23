import { afterAll, mock } from "bun:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_FILE = /\.test\.tsx?$/;
const mockModule = mock.module.bind(mock);

const scoped = new Map<string, Record<string, unknown>>();

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
