import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { createQuitStateFlush } from "../../../../../src/main/infra/main-shutdown";
import { errnoText } from "../../../../../src/main/infra/storage/errno-text";
import { writeStateFile } from "../../../../../src/main/infra/storage/state-file";
import { AppStateSchema } from "../../../../../src/main/infra/storage/state-service";
import { closeTestStates, openTestState } from "../../../../helpers/test-state";
import { mainWarnMock } from "../../../../log-test-spies";

const ERRNO_LINE = /^E[A-Z]+ \(rename\)$/;

function failureOf(run: () => void): NodeJS.ErrnoException {
  try {
    run();
  } catch (error) {
    return error as NodeJS.ErrnoException;
  }
  throw new Error("Expected the file operation to fail");
}

describe("app state save failures in the log", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-state-log-"));
    filePath = path.join(tmpDir, "state.json");
    mainWarnMock.mockClear();
  });

  afterEach(async () => {
    await closeTestStates();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function expectNoPath(line: string): void {
    expect(line).not.toContain(tmpDir);
    expect(line).not.toContain(path.basename(tmpDir));
    expect(line).not.toContain("state.json");
  }

  it("names an fs error by its code and system call", () => {
    const error = failureOf(() => fs.renameSync(path.join(tmpDir, "missing"), filePath));
    expect(error.message).toContain(tmpDir);
    expect(errnoText(error)).toBe("ENOENT (rename)");
    expect(errnoText(new Error("ENOSPC"))).toBeUndefined();
    expect(errnoText(Object.assign(new Error("no call"), { code: "ERR_WORKER_INIT_FAILED" }))).toBe(
      undefined,
    );
    expect(errnoText("EPERM")).toBeUndefined();
  });

  it("leaves the paths out of the quit lines", () => {
    fs.mkdirSync(filePath);
    fs.mkdirSync(`${filePath}.pending`);
    const service = openTestState(filePath);
    service.setState({ sidebarWidth: 250 });
    const warnings: string[] = [];
    const errors: string[] = [];
    const flushBeforeQuit = createQuitStateFlush(
      {
        flush: () => service.flushNow(),
        keep: () => service.keepForNextLaunch(),
        quit: () => {},
        warn: (message) => void warnings.push(message),
        error: (message) => void errors.push(message),
      },
      { setTimeout: () => undefined, clearTimeout: () => {} },
    );
    const event = { preventDefault: () => {} };
    expect(flushBeforeQuit(event)).toBe(false);
    expect(flushBeforeQuit(event)).toBe(false);
    expect(flushBeforeQuit(event)).toBe(true);

    expect(warnings).toHaveLength(2);
    for (const line of warnings) {
      expectNoPath(line);
      expect(line.replace("Could not save app state before quit; retrying: ", "")).toMatch(
        ERRNO_LINE,
      );
    }
    expect(errors).toHaveLength(1);
    const [line = ""] = errors;
    expectNoPath(line);
    const [saved, kept] = line
      .replace("Could not save app state before quit after 3 attempts: ", "")
      .split("; the copy for the next launch failed too: ");
    expect(saved).toMatch(ERRNO_LINE);
    expect(kept).toMatch(ERRNO_LINE);
  });

  it("leaves the paths out of the background save line", async () => {
    fs.mkdirSync(filePath);
    const service = openTestState(filePath);
    service.setState({ sidebarWidth: 250 });
    const retrying = "Could not save app state; retrying: ";
    const deadline = performance.now() + 8_000;
    let line: string | undefined;
    while (!line && performance.now() < deadline) {
      await setTimeout(10);
      line = mainWarnMock.mock.calls
        .map(([message]) => message)
        .find((m) => m.startsWith(retrying));
    }
    expect(line).toBeDefined();
    expectNoPath(line ?? "");
    expect(line?.slice(retrying.length)).toMatch(ERRNO_LINE);
  });

  it("leaves the paths out of a failed rename whose cleanup fails too", () => {
    const renameError = failureOf(() => fs.renameSync(path.join(tmpDir, "missing"), filePath));
    const unlinkError = failureOf(() => fs.unlinkSync(tmpDir));
    const unlink = spyOn(fs, "unlinkSync").mockImplementationOnce(() => {
      throw unlinkError;
    });
    let failure: unknown;
    try {
      writeStateFile(filePath, `${filePath}.vsctmp`, AppStateSchema.parse({}), {
        rename: () => {
          throw renameError;
        },
      });
    } catch (error) {
      failure = error;
    } finally {
      unlink.mockRestore();
    }
    expect(failure).toBeInstanceOf(AggregateError);
    const message = (failure as AggregateError).message;
    expectNoPath(message);
    expect(message).toMatch(/^ENOENT \(rename\); temporary file cleanup: E[A-Z]+ \(unlink\)$/);
  });
});
