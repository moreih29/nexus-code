import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { type AppState, AppStateSchema } from "../../../../../src/main/infra/storage/state-service";
import { StateWriter } from "../../../../../src/main/infra/storage/state-writer";
import { GitPanelStateUpdateSchema } from "../../../../../src/shared/git/types";
import { ipcContract } from "../../../../../src/shared/ipc/contract";
import { VoiceNamePreferencesSchema } from "../../../../../src/shared/notes/voice-names";
import { closeTestStates, openTestState } from "../../../../helpers/test-state";
import { mainWarnMock } from "../../../../log-test-spies";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-state-test-"));
}

async function waitFor(description: string, done: () => boolean): Promise<void> {
  const deadline = performance.now() + 8_000;
  while (!done()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await setTimeout(10);
  }
}

function readState(filePath: string): AppState {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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

describe("StateService", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(async () => {
    await closeTestStates();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("atomically replaces an existing file from the worker", async () => {
    const filePath = path.join(tmpDir, "state.json");
    const tmpPath = `${filePath}.vsctmp`;
    const svc = openTestState(filePath);
    svc.setState({ lastActiveWorkspaceId: "ws-1" });
    svc.flushNow();
    svc.setState({ lastActiveWorkspaceId: "ws-2" });

    await waitFor(
      "the worker's replacement",
      () => readState(filePath).lastActiveWorkspaceId === "ws-2",
    );
    expect(fs.existsSync(tmpPath)).toBe(false);
    const persisted = fs.statSync(filePath);
    if (process.platform !== "win32") {
      expect(persisted.mode & 0o777).toBe(0o666 & ~process.umask());
    }
  });

  it.each([
    "write",
    "rename",
  ] as const)("preserves the committed file after a synchronous %s failure", (stage) => {
    const filePath = path.join(tmpDir, "state.json");
    const service = openTestState(filePath);
    service.setState({ lastActiveWorkspaceId: "old" });
    service.flushNow();
    const original = fs.readFileSync(filePath);
    const error = new Error(`state ${stage} failed`);
    const write = fs.writeFileSync;
    const fail =
      stage === "write"
        ? spyOn(fs, "writeFileSync").mockImplementationOnce((fd) => {
            write(fd, "{");
            throw error;
          })
        : spyOn(fs, "renameSync").mockImplementationOnce(() => {
            throw error;
          });
    service.setState({ lastActiveWorkspaceId: "new" });
    try {
      expect(() => service.flushNow()).toThrow(error.message);
    } finally {
      fail.mockRestore();
    }

    expect(service.getState().lastActiveWorkspaceId).toBe("new");
    expect(fs.readFileSync(filePath)).toEqual(original);
    expect(fs.readdirSync(tmpDir)).toEqual(["state.json"]);
    service.flushNow();
    expect(readState(filePath).lastActiveWorkspaceId).toBe("new");
  });

  it("keeps pending updates but rejects a coordinated change if its commit fails", () => {
    const filePath = path.join(tmpDir, "state.json");
    const service = openTestState(filePath);
    service.commitState({ sidebarWidth: 200, density: "default" });
    service.setState({ sidebarWidth: 250 });
    const rename = spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("Rename failed");
    });
    try {
      expect(() => service.commitState({ density: "compact" })).toThrow("Rename failed");
    } finally {
      rename.mockRestore();
    }
    expect(readState(filePath)).toMatchObject({ sidebarWidth: 200, density: "default" });
    expect(service.getState()).toMatchObject({ sidebarWidth: 250, density: "default" });
    service.flushNow();
    expect(readState(filePath)).toMatchObject({ sidebarWidth: 250, density: "default" });
  });

  it("coalesces ten updates into two writes when the first write is in flight", async () => {
    const service = openTestState(path.join(tmpDir, "state.json"));
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const saved = Promise.withResolvers<void>();
    const originalWrite = StateWriter.prototype.write;
    const widths: (number | undefined)[] = [];
    const write = spyOn(StateWriter.prototype, "write").mockImplementation(async function (
      this: StateWriter,
      state,
      gate,
    ) {
      widths.push(state.sidebarWidth);
      if (widths.length === 1) {
        started.resolve();
        await release.promise;
      }
      const result = await originalWrite.call(this, state, gate);
      if (state.sidebarWidth === 290) saved.resolve();
      return result;
    });
    try {
      service.setState({ sidebarWidth: 200 });
      await started.promise;
      for (let i = 1; i < 10; i++) service.setState({ sidebarWidth: 200 + 10 * i });
      expect(service.getState().sidebarWidth).toBe(290);
      expect(widths).toEqual([200]);
      release.resolve();
      await saved.promise;
      expect(widths).toEqual([200, 290]);
      expect(readState(path.join(tmpDir, "state.json")).sidebarWidth).toBe(290);
    } finally {
      release.resolve();
      write.mockRestore();
    }
  });

  it("saves subsequent changes synchronously after a worker load failure", async () => {
    const filePath = path.join(tmpDir, "state.json");
    const write = spyOn(StateWriter.prototype, "write");
    mainWarnMock.mockClear();
    try {
      const service = openTestState(filePath, path.join(tmpDir, "missing.js"));
      service.setState({ sidebarWidth: 250 });
      await waitFor("the synchronous fallback", () => fs.existsSync(filePath));
      expect(readState(filePath).sidebarWidth).toBe(250);
      service.setState({ sidebarWidth: 270 });
      await waitFor("another fallback write", () => readState(filePath).sidebarWidth === 270);
      expect(write).toHaveBeenCalledTimes(1);
      const fallbacks = mainWarnMock.mock.calls
        .map(([message]) => message)
        .filter((message) => message.includes("using synchronous writes"));
      expect(fallbacks).toHaveLength(1);
      expect(fallbacks[0]).toStartWith(
        "App state worker unavailable; using synchronous writes: Error: ",
      );
      expect(fallbacks[0]).not.toContain("Error: Error:");
    } finally {
      write.mockRestore();
    }
  });

  it("restarts a worker that exits during a write", async () => {
    const filePath = path.join(tmpDir, "state.json");
    const workerPath = workerWithHook(
      tmpDir,
      `
const sync = fs.fsyncSync;
fs.fsyncSync = (fd) => {
  if (!fs.existsSync(statePath + ".crashed")) {
    fs.writeFileSync(statePath + ".crashed", "");
    process.exit(7);
  }
  sync(fd);
};`,
    );
    const service = openTestState(filePath, workerPath);
    service.setState({ sidebarWidth: 250 });
    await waitFor("the first worker to exit", () => fs.existsSync(`${filePath}.crashed`));
    service.setState({ sidebarWidth: 270 });
    await waitFor("the restarted worker's write", () => fs.existsSync(filePath));
    expect(readState(filePath).sidebarWidth).toBe(270);
  });

  it("falls back after three workers fail in a row", async () => {
    const filePath = path.join(tmpDir, "state.json");
    const workerPath = workerWithHook(
      tmpDir,
      `
fs.fsyncSync = () => {
  fs.appendFileSync(statePath + ".crashes", "x");
  process.exit(7);
};`,
    );
    const service = openTestState(filePath, workerPath);
    service.setState({ sidebarWidth: 270 });
    await waitFor("the fallback after repeated worker exits", () => fs.existsSync(filePath));
    expect(readState(filePath).sidebarWidth).toBe(270);
    expect(fs.readFileSync(`${filePath}.crashes`, "utf8")).toBe("xxx");
  }, 10_000);

  it.each([
    "EBUSY",
    "EPERM",
  ])("logs a %s replacement, retains the old file and retries the newest state", async (code) => {
    const filePath = path.join(tmpDir, "state.json");
    const workerPath = workerWithHook(
      tmpDir,
      `
const rename = fs.renameSync;
fs.renameSync = (...args) => {
  fs.renameSync = rename;
  throw Object.assign(new Error("${code}: destination locked"), { code: "${code}" });
};`,
    );
    const service = openTestState(filePath, workerPath);
    service.setState({ sidebarWidth: 250 });
    service.flushNow();
    mainWarnMock.mockClear();
    service.setState({ sidebarWidth: 260 });
    await waitFor("the retry log", () =>
      mainWarnMock.mock.calls.some(([message]) => message.includes(`${code}: destination locked`)),
    );
    expect(mainWarnMock.mock.calls.map(([message]) => message)).toContain(
      `Could not save app state; retrying: Error: ${code}: destination locked`,
    );
    expect(readState(filePath).sidebarWidth).toBe(250);
    expect(fs.existsSync(`${filePath}.vsctmp`)).toBe(false);
    service.setState({ sidebarWidth: 270 });
    await waitFor("the retried replacement", () => readState(filePath).sidebarWidth === 270);
  });

  it("logs a failed replacement and its failed cleanup with one error prefix", async () => {
    const filePath = path.join(tmpDir, "state.json");
    const workerPath = workerWithHook(
      tmpDir,
      `
const rename = fs.renameSync;
const unlink = fs.unlinkSync;
fs.renameSync = () => {
  fs.renameSync = rename;
  throw new Error("EBUSY: destination locked");
};
fs.unlinkSync = () => {
  fs.unlinkSync = unlink;
  throw new Error("EBUSY: temporary file locked");
};`,
    );
    const service = openTestState(filePath, workerPath);
    service.setState({ sidebarWidth: 250 });
    service.flushNow();
    mainWarnMock.mockClear();
    service.setState({ sidebarWidth: 260 });
    await waitFor("the retry log", () =>
      mainWarnMock.mock.calls.some(([message]) => message.includes("temporary file cleanup")),
    );
    expect(mainWarnMock.mock.calls.map(([message]) => message)).toContain(
      "Could not save app state; retrying: Error: AggregateError: EBUSY: destination locked; temporary file cleanup: EBUSY: temporary file locked",
    );
    await waitFor("the retried replacement", () => readState(filePath).sidebarWidth === 260);
  });

  it("keeps the name of a worker error that is not a plain Error", async () => {
    const filePath = path.join(tmpDir, "state.json");
    const workerPath = workerWithHook(
      tmpDir,
      `
const rename = fs.renameSync;
fs.renameSync = () => {
  fs.renameSync = rename;
  throw new TypeError("rename is not available");
};`,
    );
    const service = openTestState(filePath, workerPath);
    service.setState({ sidebarWidth: 250 });
    service.flushNow();
    mainWarnMock.mockClear();
    service.setState({ sidebarWidth: 260 });
    await waitFor("the retry log", () =>
      mainWarnMock.mock.calls.some(([message]) => message.includes("rename is not available")),
    );
    expect(mainWarnMock.mock.calls.map(([message]) => message)).toContain(
      "Could not save app state; retrying: Error: TypeError: rename is not available",
    );
    await waitFor("the retried replacement", () => readState(filePath).sidebarWidth === 260);
  });

  it("flushNow waits for an earlier rename already in progress", async () => {
    const filePath = path.join(tmpDir, "state.json");
    const workerPath = workerWithHook(
      tmpDir,
      `
const rename = fs.renameSync;
fs.renameSync = (...args) => {
  fs.writeFileSync(statePath + ".renaming", "");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  rename(...args);
};`,
    );
    const service = openTestState(filePath, workerPath);
    service.setState({ sidebarWidth: 255 });
    await waitFor("the worker's rename to start", () => fs.existsSync(`${filePath}.renaming`));
    service.setState({ sidebarWidth: 288 });
    service.flushNow();
    expect(readState(filePath).sidebarWidth).toBe(288);
    expect(fs.existsSync(`${filePath}.vsctmp`)).toBe(false);
  });

  it("times out a stalled rename, retires the worker and saves the latest state", async () => {
    const filePath = path.join(tmpDir, "state.json");
    const workerPath = workerWithHook(
      tmpDir,
      `
const rename = fs.renameSync;
fs.renameSync = (...args) => {
  if (!fs.existsSync(statePath + ".stalled")) {
    fs.writeFileSync(statePath + ".stalled", "");
    const deadline = performance.now() + 8_000;
    while (performance.now() < deadline) {}
    fs.writeFileSync(statePath + ".escaped", "");
  }
  rename(...args);
};`,
    );
    const service = openTestState(filePath, workerPath);
    service.setState({ sidebarWidth: 250 });
    service.flushNow();
    service.setState({ sidebarWidth: 260 });
    await waitFor("the rename to stall", () => fs.existsSync(`${filePath}.stalled`));
    service.setState({ sidebarWidth: 270 });
    expect(() => service.flushNow()).toThrow("Timed out waiting for the earlier app state rename");
    expect(readState(filePath).sidebarWidth).toBe(250);
    await waitFor(
      "the write by the replacement worker",
      () => readState(filePath).sidebarWidth === 270,
    );
    expect(fs.existsSync(`${filePath}.escaped`)).toBe(false);
  }, 12_000);

  it("cancels a partial transfer of workspace layouts before the next write", async () => {
    const filePath = path.join(tmpDir, "state.json");
    const service = openTestState(filePath);
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    const rootId = crypto.randomUUID();
    const layout = {
      root: { kind: "leaf" as const, id: rootId, tabIds: [], activeTabId: null },
      activeGroupId: rootId,
      tabs: [],
    };
    const sent = Promise.withResolvers<void>();
    const post = Worker.prototype.postMessage;
    const send = spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      ...args: Parameters<Worker["postMessage"]>
    ) {
      const [message] = args;
      if (message.kind === "layout" && message.id === first) sent.resolve();
      post.apply(this, args);
    });
    try {
      service.setState({ layoutByWorkspace: { [first]: layout, [second]: layout } });
      await sent.promise;
      service.setState({ layoutByWorkspace: { [second]: layout } });
      service.flushNow();
      service.setState({ sidebarWidth: 270 });
      await waitFor("the next background write", () => readState(filePath).sidebarWidth === 270);
      expect(Object.keys(readState(filePath).layoutByWorkspace ?? {})).toEqual([second]);
      const transfers = send.mock.calls.reduce<string[][]>((all, [message]) => {
        if (message.kind === "reset") all.push([]);
        else if (message.kind === "layout") all.at(-1)?.push(message.id);
        return all;
      }, []);
      const [cancelled, ...later] = transfers;
      expect(cancelled).toEqual([first]);
      expect(later.length).toBeGreaterThan(0);
      expect(later).toEqual(later.map(() => [second]));
    } finally {
      send.mockRestore();
    }
  });

  it("flushNow cancels an older worker write still preparing its file", async () => {
    const filePath = path.join(tmpDir, "state.json");
    const workerPath = workerWithHook(
      tmpDir,
      `
const sync = fs.fsyncSync;
fs.fsyncSync = (fd) => {
  sync(fd);
  fs.writeFileSync(statePath + ".ready", "");
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const deadline = performance.now() + 4_000;
  while (!fs.existsSync(statePath + ".release") && performance.now() < deadline) {
    Atomics.wait(gate, 0, 0, 5);
  }
};`,
    );
    const service = openTestState(filePath, workerPath);
    service.setState({ sidebarWidth: 255 });
    await waitFor("the worker's prepared file", () => fs.existsSync(`${filePath}.ready`));
    try {
      service.setState({ sidebarWidth: 288 });
      service.flushNow();
      expect(readState(filePath).sidebarWidth).toBe(288);
    } finally {
      fs.writeFileSync(`${filePath}.release`, "");
    }
    await waitFor("the cancelled write to finish", () => !fs.existsSync(`${filePath}.vsctmp`));
    expect(readState(filePath).sidebarWidth).toBe(288);
  });

  it("keeps the last committed JSON when the process is killed mid-write", async () => {
    const filePath = path.join(tmpDir, "state.json");
    const service = openTestState(filePath);
    service.setState({ sidebarWidth: 255 });
    service.flushNow();

    const workerPath = workerWithHook(
      tmpDir,
      `
const write = fs.writeFileSync;
fs.writeFileSync = (fd) => {
  write(fd, "{");
  write(statePath + ".ready", "");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};`,
    );
    const stateModule = new URL(
      "../../../../../src/main/infra/storage/state-service.ts",
      import.meta.url,
    );
    const child = Bun.spawn([
      process.execPath,
      "-e",
      `import { StateService } from ${JSON.stringify(stateModule.href)};
const [, filePath, workerPath] = process.argv;
new StateService(filePath, workerPath).setState({ sidebarWidth: 288 });
await Bun.sleep(10_000);`,
      filePath,
      workerPath,
    ]);
    try {
      await waitFor("a partially written temporary file", () => fs.existsSync(`${filePath}.ready`));
      expect(fs.readFileSync(`${filePath}.vsctmp`, "utf8")).toBe("{");
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
    expect(openTestState(filePath).getState().sidebarWidth).toBe(255);
    expect(fs.existsSync(`${filePath}.invalid`)).toBe(false);
  });

  it("mergeState merges without overwriting unrelated fields", () => {
    const filePath = path.join(tmpDir, "state.json");
    const svc = openTestState(filePath);
    svc.setState({
      lastActiveWorkspaceId: "ws-1",
      windowBounds: { x: 0, y: 0, width: 1280, height: 800 },
    });
    svc.mergeState({ lastActiveWorkspaceId: "ws-2" });

    const state = svc.getState();
    expect(state.lastActiveWorkspaceId).toBe("ws-2");
    expect(state.windowBounds?.width).toBe(1280);
    svc.flushNow();
  });

  it("keeps the valid fields when one persisted field no longer validates", () => {
    const filePath = path.join(tmpDir, "state.json");
    const original = JSON.stringify({
      lastActiveWorkspaceId: "ws-kept",
      sidebarWidth: 280,
      density: "spacious",
    });
    fs.writeFileSync(filePath, original, "utf8");

    const state = openTestState(filePath).getState();

    expect(state.lastActiveWorkspaceId).toBe("ws-kept");
    expect(state.sidebarWidth).toBe(280);
    expect(state.density).toBeUndefined();
    expect(state.updateChannel).toBe("stable");
    expect(fs.readFileSync(`${filePath}.invalid`, "utf8")).toBe(original);
  });

  it("drops only the invalid entries of a record field", () => {
    const filePath = path.join(tmpDir, "state.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        lspLanguages: { typescript: { lowMemory: true }, python: { enabled: "no" } },
      }),
      "utf8",
    );

    const state = openTestState(filePath).getState();

    expect(state.lspLanguages).toEqual({ typescript: { lowMemory: true } });
  });

  it("loads a saved workspace ID using the legacy UUID format", () => {
    const filePath = path.join(tmpDir, "state.json");
    const workspaceId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const original = {
      updateChannel: "beta",
      filesPanelModeByWorkspace: { [workspaceId]: "tree" },
    };
    fs.writeFileSync(filePath, JSON.stringify(original), "utf8");

    expect(openTestState(filePath).getState()).toMatchObject(original);
    expect(fs.existsSync(`${filePath}.invalid`)).toBe(false);
  });

  it("leaves omitted settings out of partial updates", () => {
    expect(ipcContract.appState.call.set.args.parse({ updateChannel: "beta" })).toEqual({
      updateChannel: "beta",
    });
    expect(GitPanelStateUpdateSchema.parse({ commitDraft: "draft" })).toEqual({
      commitDraft: "draft",
    });
    expect(VoiceNamePreferencesSchema.parse({ suggest: false })).toEqual({ suggest: false });
  });

  it("loads usage-limit resume defaults and persists independent setting changes", () => {
    const filePath = path.join(tmpDir, "state.json");
    const service = openTestState(filePath);
    expect(service.getState()).toMatchObject({
      chatLimitResume: true,
      chatLimitResumeDelayMinutes: 1,
      chatLimitResumeMaxTries: 3,
      chatLimitResumeDeadlineHours: 12,
      chatLimitResumeMessage: "",
    });
    const patch = ipcContract.appState.call.set.args;
    service.setState(patch.parse({ chatLimitResumeDelayMinutes: 0, chatLimitResumeMaxTries: 10 }));
    service.setState(
      patch.parse({ chatLimitResumeDeadlineHours: 168, chatLimitResumeMessage: "Continue" }),
    );
    service.flushNow();
    expect(openTestState(filePath).getState()).toMatchObject({
      chatLimitResume: true,
      chatLimitResumeDelayMinutes: 0,
      chatLimitResumeMaxTries: 10,
      chatLimitResumeDeadlineHours: 168,
      chatLimitResumeMessage: "Continue",
    });
  });

  it("rejects the same invalid patches as validating the whole state", () => {
    const service = openTestState(path.join(tmpDir, "state.json"));
    const original = service.getState();
    for (const input of [
      { autoCheckForUpdates: false, sidebarWidth: -1 },
      { editorFontSize: 8.5 },
      { windowBounds: { x: 0, y: 0, width: NaN, height: 800 } },
      { layoutByWorkspace: { [crypto.randomUUID()]: { tabs: [] } } },
      { layoutByWorkspace: { "invalid-id": {} } },
      { lspLanguages: { typescript: { enabled: "no" } } },
      { chatLimitResumeMessage: "First line\nSecond line" },
    ]) {
      expect(AppStateSchema.safeParse({ ...original, ...input }).success).toBe(false);
      expect(() => service.setState(input as Partial<AppState>)).toThrow();
      expect(service.getState()).toBe(original);
    }
  });

  it("discards removed layout entries before validating retained layouts", () => {
    const filePath = path.join(tmpDir, "state.json");
    const service = openTestState(filePath);
    const removed = crypto.randomUUID();
    const remaining = crypto.randomUUID();
    const rootId = crypto.randomUUID();
    const layout = {
      root: { kind: "leaf" as const, id: rootId, tabIds: [], activeTabId: null },
      activeGroupId: rootId,
      tabs: [],
    };
    const invalid = { tabs: [] } as unknown as typeof layout;
    service.commitState({ layoutByWorkspace: { [removed]: layout } });
    service.setState(
      { sidebarWidth: 250, layoutByWorkspace: { [removed]: invalid, [remaining]: layout } },
      { workspaceIds: [remaining] },
    );
    expect(() =>
      service.setState(
        { layoutByWorkspace: { [remaining]: invalid } },
        { workspaceIds: [remaining] },
      ),
    ).toThrow();
    service.flushNow();
    expect(readState(filePath)).toMatchObject({
      sidebarWidth: 250,
      layoutByWorkspace: { [remaining]: layout },
    });
    expect(readState(filePath).layoutByWorkspace?.[removed]).toBeUndefined();
  });

  it("rejects invalid usage-limit resume updates and restores defaults for invalid saved values", () => {
    const patch = ipcContract.appState.call.set.args;
    for (const input of [
      { chatLimitResumeDelayMinutes: -1 },
      { chatLimitResumeDelayMinutes: 61 },
      { chatLimitResumeDelayMinutes: 0.5 },
      { chatLimitResumeMaxTries: 0 },
      { chatLimitResumeMaxTries: 11 },
      { chatLimitResumeDeadlineHours: 0 },
      { chatLimitResumeDeadlineHours: 169 },
      { chatLimitResumeMessage: "First line\nSecond line" },
    ]) {
      expect(patch.safeParse(input).success).toBe(false);
    }
    const filePath = path.join(tmpDir, "state.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        chatLimitResume: false,
        chatLimitResumeDelayMinutes: 90,
        chatLimitResumeMaxTries: 7,
      }),
    );
    expect(openTestState(filePath).getState()).toMatchObject({
      chatLimitResume: false,
      chatLimitResumeDelayMinutes: 1,
      chatLimitResumeMaxTries: 7,
    });
  });

  it("backs up a state file that is not valid JSON", () => {
    const filePath = path.join(tmpDir, "state.json");
    fs.writeFileSync(filePath, "{ truncated", "utf8");

    const state = openTestState(filePath).getState();

    expect(state.updateChannel).toBe("stable");
    expect(fs.readFileSync(`${filePath}.invalid`, "utf8")).toBe("{ truncated");
  });
});
