import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { createQuitStateFlush } from "../../../../../src/main/infra/main-shutdown";
import { openTestState } from "../../../../helpers/test-state";
import { mainInfoMock, mainWarnMock } from "../../../../log-test-spies";

const OLDER = new Date("2026-01-01T00:00:00Z");
const NEWER = new Date("2026-01-02T00:00:00Z");

async function waitFor(description: string, done: () => boolean): Promise<void> {
  const deadline = performance.now() + 8_000;
  while (!done()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await setTimeout(10);
  }
}

function readState(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeAt(filePath: string, text: string, time: Date): void {
  fs.writeFileSync(filePath, text);
  fs.utimesSync(filePath, time, time);
}

function lockedRenames(locked: (from: string, to: string) => boolean) {
  const rename = fs.renameSync;
  return spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (locked(String(from), String(to))) {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    }
    rename(from, to);
  });
}

function workerWithHook(dir: string, hook: string): string {
  const workerPath = path.join(dir, "test-worker.ts");
  const productionWorker = new URL(
    "../../../../../src/main/infra/storage/state-writer.worker.ts",
    import.meta.url,
  );
  fs.writeFileSync(
    workerPath,
    `import fs from "node:fs";
import { workerData as statePath } from "node:worker_threads";
${hook}
await import(${JSON.stringify(productionWorker.href)});`,
  );
  return workerPath;
}

describe("StateService copy kept at quit", () => {
  let tmpDir: string;
  let filePath: string;
  let pendingPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-state-pending-"));
    filePath = path.join(tmpDir, "state.json");
    pendingPath = `${filePath}.pending`;
    mainWarnMock.mockClear();
    mainInfoMock.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function warnings(): string[] {
    return mainWarnMock.mock.calls.map(([message]) => message);
  }

  it("keeps the last state when every quit flush fails and restores it on the next launch", async () => {
    const quitting = openTestState(filePath);
    quitting.setState({ sidebarWidth: 250 });
    quitting.flushNow();
    quitting.setState({ sidebarWidth: 999 });
    const errors: string[] = [];
    const retries: (() => void)[] = [];
    const event = { preventDefault: () => {} };
    let quit = false;
    const flushBeforeQuit = createQuitStateFlush(
      {
        flush: () => quitting.flushNow(),
        keep: () => quitting.keepForNextLaunch(),
        quit: () => {
          quit = flushBeforeQuit(event);
        },
        warn: () => {},
        error: (message) => errors.push(message),
      },
      {
        setTimeout: (callback) => {
          retries.push(callback);
          return callback;
        },
        clearTimeout: () => {},
      },
    );
    const lock = lockedRenames((_from, to) => to === filePath);
    try {
      quit = flushBeforeQuit(event);
      while (!quit) {
        const retry = retries.shift();
        if (!retry) throw new Error("The quit flush stopped without finishing");
        retry();
      }
    } finally {
      lock.mockRestore();
    }

    expect(errors).toHaveLength(1);
    expect(errors[0]).toEndWith("; kept a copy for the next launch");
    expect(readState(filePath).sidebarWidth).toBe(250);
    expect(readState(pendingPath).sidebarWidth).toBe(999);
    expect(fs.readdirSync(tmpDir).sort()).toEqual(["state.json", "state.json.pending"]);

    const nextDir = path.join(tmpDir, "next");
    const nextFile = path.join(nextDir, "state.json");
    fs.mkdirSync(nextDir);
    writeAt(nextFile, fs.readFileSync(filePath, "utf8"), OLDER);
    writeAt(`${nextFile}.pending`, fs.readFileSync(pendingPath, "utf8"), NEWER);
    expect(openTestState(nextFile).getState().sidebarWidth).toBe(999);
    expect(readState(nextFile).sidebarWidth).toBe(999);
    expect(fs.readdirSync(nextDir)).toEqual(["state.json"]);
    expect(mainInfoMock.mock.calls.map(([message]) => message)).toContain(
      "Restored the app state kept at the last quit",
    );

    await waitFor("the quitting service's later save", () => !fs.existsSync(pendingPath));
    expect(readState(filePath).sidebarWidth).toBe(999);
  });

  it.each([
    ["an older saved state", true],
    ["no saved state", false],
  ])("restores the kept copy over %s", (_label, saved) => {
    if (saved) writeAt(filePath, JSON.stringify({ sidebarWidth: 250 }), OLDER);
    writeAt(pendingPath, JSON.stringify({ sidebarWidth: 999 }), NEWER);

    expect(openTestState(filePath).getState().sidebarWidth).toBe(999);
    expect(readState(filePath).sidebarWidth).toBe(999);
    expect(fs.readdirSync(tmpDir)).toEqual(["state.json"]);
    expect(warnings()).toEqual([]);
  });

  it("discards a kept copy older than the saved state", () => {
    writeAt(filePath, JSON.stringify({ sidebarWidth: 270 }), NEWER);
    writeAt(pendingPath, JSON.stringify({ sidebarWidth: 999 }), OLDER);

    expect(openTestState(filePath).getState().sidebarWidth).toBe(270);
    expect(fs.readdirSync(tmpDir)).toEqual(["state.json"]);
    expect(warnings()).toEqual([
      "Discarded the app state kept at the last quit: the saved state is newer",
    ]);
  });

  it.each([
    ["{ truncated", "it is not valid JSON"],
    ["[1]", "it is not a JSON object"],
    ["null", "it is not a JSON object"],
  ])("discards a broken kept copy %s and logs why without its path", (text, reason) => {
    writeAt(filePath, JSON.stringify({ sidebarWidth: 250 }), OLDER);
    writeAt(pendingPath, text, NEWER);

    expect(openTestState(filePath).getState().sidebarWidth).toBe(250);
    expect(fs.readdirSync(tmpDir)).toEqual(["state.json"]);
    expect(warnings()).toEqual([`Discarded the app state kept at the last quit: ${reason}`]);
    expect(warnings().join("\n")).not.toContain(tmpDir);
  });

  it("leaves an unreadable kept copy for the next launch", () => {
    writeAt(filePath, JSON.stringify({ sidebarWidth: 250 }), OLDER);
    writeAt(pendingPath, JSON.stringify({ sidebarWidth: 999 }), NEWER);
    const read = fs.readFileSync;
    const unreadable = spyOn(fs, "readFileSync").mockImplementation(((
      file: fs.PathOrFileDescriptor,
      options?: unknown,
    ) => {
      if (file === pendingPath) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return read(file, options as BufferEncoding);
    }) as typeof fs.readFileSync);
    try {
      expect(openTestState(filePath).getState().sidebarWidth).toBe(250);
    } finally {
      unreadable.mockRestore();
    }
    expect(fs.existsSync(pendingPath)).toBe(true);
    expect(warnings()).toEqual([
      "Ignored the app state kept at the last quit: it could not be read (EACCES)",
    ]);

    expect(openTestState(filePath).getState().sidebarWidth).toBe(999);
    expect(fs.readdirSync(tmpDir)).toEqual(["state.json"]);
  });

  it("uses a kept copy that cannot replace the saved state and saves it in the background", async () => {
    writeAt(filePath, JSON.stringify({ sidebarWidth: 250 }), OLDER);
    writeAt(pendingPath, JSON.stringify({ sidebarWidth: 999 }), NEWER);
    const lock = lockedRenames((from) => from === pendingPath);
    let service: ReturnType<typeof openTestState>;
    try {
      service = openTestState(filePath);
    } finally {
      lock.mockRestore();
    }

    expect(service.getState().sidebarWidth).toBe(999);
    expect(readState(filePath).sidebarWidth).toBe(250);
    expect(fs.existsSync(pendingPath)).toBe(true);
    expect(warnings()).toEqual([
      "Using the app state kept at the last quit until the next save: it could not replace the saved state (EPERM)",
    ]);
    await waitFor("the background save", () => !fs.existsSync(pendingPath));
    expect(readState(filePath).sidebarWidth).toBe(999);
    expect(fs.readdirSync(tmpDir)).toEqual(["state.json"]);
  });

  it("drops the kept copy once a synchronous save writes over it", () => {
    writeAt(filePath, JSON.stringify({ sidebarWidth: 250 }), OLDER);
    writeAt(pendingPath, JSON.stringify({ sidebarWidth: 999 }), NEWER);
    const lock = lockedRenames((from) => from === pendingPath);
    let service: ReturnType<typeof openTestState>;
    try {
      service = openTestState(filePath);
    } finally {
      lock.mockRestore();
    }
    service.setState({ density: "compact" });
    service.flushNow();

    expect(readState(filePath)).toMatchObject({ sidebarWidth: 999, density: "compact" });
    expect(fs.readdirSync(tmpDir)).toEqual(["state.json"]);
  });

  it("migrates a kept copy from an earlier version", () => {
    writeAt(filePath, JSON.stringify({ sidebarWidth: 250 }), OLDER);
    writeAt(pendingPath, JSON.stringify({ sessionsViewDefault: "task", sidebarWidth: 999 }), NEWER);

    expect(openTestState(filePath).getState()).toMatchObject({
      agentListViewDefault: "task",
      sidebarWidth: 999,
    });
    expect(fs.readdirSync(tmpDir)).toEqual(["state.json"]);
  });

  it("restores a kept copy from a later version without its unknown fields", () => {
    writeAt(filePath, JSON.stringify({ sidebarWidth: 250 }), OLDER);
    writeAt(pendingPath, JSON.stringify({ sidebarWidth: 999, laterField: { on: true } }), NEWER);

    const state = openTestState(filePath).getState() as Record<string, unknown>;
    expect(state.sidebarWidth).toBe(999);
    expect(state).not.toHaveProperty("laterField");
  });

  it("leaves no partial copy when the kept copy cannot be written either", async () => {
    const service = openTestState(filePath);
    service.setState({ sidebarWidth: 250 });
    service.flushNow();
    service.setState({ sidebarWidth: 999 });
    const lock = lockedRenames((_from, to) => to === filePath || to === pendingPath);
    try {
      expect(() => service.keepForNextLaunch()).toThrow("EPERM");
    } finally {
      lock.mockRestore();
    }
    expect(fs.existsSync(pendingPath)).toBe(false);
    expect(fs.existsSync(`${pendingPath}.vsctmp`)).toBe(false);
    await waitFor("the background save", () => readState(filePath).sidebarWidth === 999);
  });

  it("keeps the copy while an older worker write lands, and drops it after the newer one", async () => {
    const workerPath = workerWithHook(
      tmpDir,
      `
const sync = fs.fsyncSync;
let round = 0;
fs.fsyncSync = (fd) => {
  sync(fd);
  round++;
  fs.writeFileSync(statePath + ".ready" + round, "");
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const deadline = performance.now() + 6_000;
  while (!fs.existsSync(statePath + ".release" + round) && performance.now() < deadline) {
    Atomics.wait(gate, 0, 0, 5);
  }
};`,
    );
    const service = openTestState(filePath, workerPath);
    service.setState({ sidebarWidth: 250 });
    await waitFor("the first write to start", () => fs.existsSync(`${filePath}.ready1`));
    service.setState({ sidebarWidth: 999 });
    service.keepForNextLaunch();
    expect(readState(pendingPath).sidebarWidth).toBe(999);

    fs.writeFileSync(`${filePath}.release1`, "");
    await waitFor("the second write to start", () => fs.existsSync(`${filePath}.ready2`));
    expect(readState(filePath).sidebarWidth).toBe(250);
    expect(readState(pendingPath).sidebarWidth).toBe(999);

    fs.writeFileSync(`${filePath}.release2`, "");
    await waitFor("the newer write to drop the copy", () => !fs.existsSync(pendingPath));
    expect(readState(filePath).sidebarWidth).toBe(999);
  });
});
