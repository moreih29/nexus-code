import { describe, expect, mock, test } from "bun:test";
import { beginRun, type MarkerFs, quitLine, startLine } from "../../../src/main/infra/run-log";

function memoryFs(initial?: string) {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set("m", initial);
  const fs: MarkerFs = {
    read: (f) => files.get(f) ?? null,
    write: (f, t) => void files.set(f, t),
    remove: (f) => void files.delete(f),
  };
  return { files, fs };
}

describe("run log", () => {
  test("start line names build, machine and time to ready", () => {
    const line = startLine({
      version: "1.2.3",
      packaged: true,
      platform: "win32",
      osRelease: "10.0.22631",
      arch: "x64",
      locale: "ko",
      electron: "40.0.0",
      readyMs: 812.4,
    });
    expect(line).toBe(
      "NexusCode started: version=1.2.3 packaged=true os=win32 10.0.22631 arch=x64 locale=ko electron=40.0.0 readyMs=812",
    );
  });

  test("a first run writes a marker and no warning", () => {
    const { files, fs } = memoryFs();
    const warn = mock();
    beginRun("m", "1.0.0", { warn }, () => 1000, fs);
    expect(warn).not.toHaveBeenCalled();
    expect(files.get("m")).toContain("1000");
  });

  test("a clean quit writes the quit line and removes the marker", () => {
    const { files, fs } = memoryFs();
    let t = 1000;
    const run = beginRun("m", "1.0.0", { warn: mock() }, () => t, fs);
    t = 61_000;
    const info = mock();
    run.quit({ info });
    expect(info).toHaveBeenCalledWith(quitLine(60_000));
    expect(info.mock.calls[0]?.[0]).toBe("NexusCode quit: uptime=60s");
    expect(files.has("m")).toBe(false);
  });

  test("a marker left behind is reported once, without the path", () => {
    const { files, fs } = memoryFs(JSON.stringify({ startedAt: 0, version: "0.9.0" }));
    const warn = mock();
    beginRun("m", "1.0.0", { warn }, () => 5, fs);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("ended without a quit line");
    expect(line).toContain("1970-01-01T00:00:00.000Z");
    expect(line).toContain("version=0.9.0");
    // The new run's own marker replaced the old one.
    expect(files.get("m")).toContain('"startedAt":5');
  });

  test("an unreadable marker still counts as a cut-short run", () => {
    const { fs } = memoryFs("not json");
    const warn = mock();
    beginRun("m", "1.0.0", { warn }, () => 5, fs);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
