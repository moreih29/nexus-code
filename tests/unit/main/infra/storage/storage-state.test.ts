import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import {
  type AppState,
  AppStateSchema,
  StateService,
} from "../../../../../src/main/infra/storage/state-service";
import { StateWriter } from "../../../../../src/main/infra/storage/state-writer";
import { GitPanelStateUpdateSchema } from "../../../../../src/shared/git/types";
import { ipcContract } from "../../../../../src/shared/ipc/contract";
import { VoiceNamePreferencesSchema } from "../../../../../src/shared/notes/voice-names";
import { mainWarnMock } from "../../../../log-test-spies";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-state-test-"));
}

async function waitFor(description: string, done: () => boolean): Promise<void> {
  const deadline = performance.now() + 4_000;
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

// ---------------------------------------------------------------------------
// StateService tests
// ---------------------------------------------------------------------------

describe("StateService", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("atomically replaces an existing file from the worker", async () => {
    const filePath = path.join(tmpDir, "state.json");
    const tmpPath = `${filePath}.vsctmp`;
    const svc = new StateService(filePath);
    svc.setState({ lastActiveWorkspaceId: "ws-1" });
    svc.flushNow();
    svc.setState({ lastActiveWorkspaceId: "ws-2" });

    await waitFor(
      "the worker's replacement",
      () => readState(filePath).lastActiveWorkspaceId === "ws-2",
    );
    // The .vsctmp file must have been renamed away.
    expect(fs.existsSync(tmpPath)).toBe(false);
    // A newly written file takes the temporary file's default mode.
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
    const service = new StateService(filePath);
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
    const service = new StateService(filePath);
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
    const service = new StateService(path.join(tmpDir, "state.json"));
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
    const service = new StateService(filePath, workerPath);
    service.setState({ sidebarWidth: 250 });
    service.flushNow();
    mainWarnMock.mockClear();
    service.setState({ sidebarWidth: 260 });
    await waitFor("the retry log", () =>
      mainWarnMock.mock.calls.some(([message]) => message.includes(`${code}: destination locked`)),
    );
    expect(readState(filePath).sidebarWidth).toBe(250);
    expect(fs.existsSync(`${filePath}.vsctmp`)).toBe(false);
    service.setState({ sidebarWidth: 270 });
    await waitFor("the retried replacement", () => readState(filePath).sidebarWidth === 270);
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
    const service = new StateService(filePath, workerPath);
    service.setState({ sidebarWidth: 255 });
    await waitFor("the worker's rename to start", () => fs.existsSync(`${filePath}.renaming`));
    service.setState({ sidebarWidth: 288 });
    service.flushNow();
    expect(readState(filePath).sidebarWidth).toBe(288);
    expect(fs.existsSync(`${filePath}.vsctmp`)).toBe(false);
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
    const service = new StateService(filePath, workerPath);
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
    const service = new StateService(filePath);
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
    expect(new StateService(filePath).getState().sidebarWidth).toBe(255);
    expect(fs.existsSync(`${filePath}.invalid`)).toBe(false);
  });

  it("mergeState merges without overwriting unrelated fields", () => {
    const filePath = path.join(tmpDir, "state.json");
    const svc = new StateService(filePath);
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

    const state = new StateService(filePath).getState();

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

    const state = new StateService(filePath).getState();

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

    expect(new StateService(filePath).getState()).toMatchObject(original);
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
    const service = new StateService(filePath);
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
    expect(new StateService(filePath).getState()).toMatchObject({
      chatLimitResume: true,
      chatLimitResumeDelayMinutes: 0,
      chatLimitResumeMaxTries: 10,
      chatLimitResumeDeadlineHours: 168,
      chatLimitResumeMessage: "Continue",
    });
  });

  it("rejects the same invalid patches as validating the whole state", () => {
    const service = new StateService(path.join(tmpDir, "state.json"));
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
    expect(new StateService(filePath).getState()).toMatchObject({
      chatLimitResume: false,
      chatLimitResumeDelayMinutes: 1,
      chatLimitResumeMaxTries: 7,
    });
  });

  it("backs up a state file that is not valid JSON", () => {
    const filePath = path.join(tmpDir, "state.json");
    fs.writeFileSync(filePath, "{ truncated", "utf8");

    const state = new StateService(filePath).getState();

    expect(state.updateChannel).toBe("stable");
    expect(fs.readFileSync(`${filePath}.invalid`, "utf8")).toBe("{ truncated");
  });
});
