import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logsPathHandler, openLogsFolderHandler } from "../../../src/main/features/shell/logs";

describe("log folder handlers", () => {
  test("logsPath answers the folder main gives", async () => {
    expect(await logsPathHandler(() => "/logs/here")()).toEqual({ path: "/logs/here" });
  });

  test("openLogsFolder makes the folder and opens it", async () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "logs-")), "NexusCode");
    const openPath = mock(async (_p: string) => "");
    const result = await openLogsFolderHandler(() => dir, { openPath })();
    expect(result).toEqual({ ok: true });
    expect(openPath).toHaveBeenCalledWith(dir);
    expect(fs.existsSync(dir)).toBe(true);
    fs.rmSync(path.dirname(dir), { recursive: true });
  });

  test("a failure of the shell comes back as open-failed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logs-"));
    const result = await openLogsFolderHandler(() => dir, { openPath: async () => "no handler" })();
    expect(result).toEqual({
      ok: false,
      error: { code: "open-failed", message: "no handler", absPath: dir },
    });
    fs.rmSync(dir, { recursive: true });
  });
});
