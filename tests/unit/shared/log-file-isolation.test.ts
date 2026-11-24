import { afterAll, beforeAll, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

type FileTransport = { level: string | false; getFile: () => { path: string } };
type LoadedLog = { transports?: { file: FileTransport } };

const g = globalThis as { __electronLog?: unknown };
const hadBridgeGlobal = "__electronLog" in g;

beforeAll(() => {
  if (!hadBridgeGlobal) g.__electronLog = undefined;
});

afterAll(() => {
  if (!hadBridgeGlobal) delete g.__electronLog;
});

test("electron-log/main under bun test writes no file and points away from the user's log folder", () => {
  const loaded = (require("electron-log/main") as { default: LoadedLog }).default;
  if (loaded.transports === undefined) {
    expect(typeof (loaded as { info?: unknown }).info).toBe("function");
    return;
  }
  const file = loaded.transports.file;
  const path = file.getFile().path;

  expect(file.level).toBe(false);
  expect(path.startsWith(tmpdir())).toBe(true);
  expect(path.startsWith(join(homedir(), "Library", "Logs"))).toBe(false);
});
