import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateService } from "../../../../../src/main/infra/storage/state-service";
import { GitPanelStateUpdateSchema } from "../../../../../src/shared/git/types";
import { ipcContract } from "../../../../../src/shared/ipc/contract";
import { VoiceNamePreferencesSchema } from "../../../../../src/shared/notes/voice-names";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-state-test-"));
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

  it("atomic write — .vsctmp file is created then renamed (not left behind)", () => {
    const filePath = path.join(tmpDir, "state.json");
    const tmpPath = `${filePath}.vsctmp`;
    const svc = new StateService(filePath);
    svc.setState({ lastActiveWorkspaceId: "ws-2" });

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
  ] as const)("preserves app state and removes its temporary file after a %s failure", (stage) => {
    const filePath = path.join(tmpDir, "state.json");
    const service = new StateService(filePath);
    service.setState({ lastActiveWorkspaceId: "old" });
    const original = fs.readFileSync(filePath);
    const error = new Error(`state ${stage} failed`);
    const write = fs.writeSync;
    const fail =
      stage === "write"
        ? spyOn(fs, "writeSync").mockImplementationOnce((fd) => {
            write(fd, "{");
            throw error;
          })
        : spyOn(fs, "renameSync").mockImplementationOnce(() => {
            throw error;
          });
    try {
      expect(() => service.setState({ lastActiveWorkspaceId: "new" })).toThrow(error.message);
    } finally {
      fail.mockRestore();
    }

    expect(service.getState().lastActiveWorkspaceId).toBe("old");
    expect(fs.readFileSync(filePath)).toEqual(original);
    expect(fs.readdirSync(tmpDir)).toEqual(["state.json"]);
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

  it("backs up a state file that is not valid JSON", () => {
    const filePath = path.join(tmpDir, "state.json");
    fs.writeFileSync(filePath, "{ truncated", "utf8");

    const state = new StateService(filePath).getState();

    expect(state.updateChannel).toBe("stable");
    expect(fs.readFileSync(`${filePath}.invalid`, "utf8")).toBe("{ truncated");
  });
});
