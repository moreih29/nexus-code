import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateService } from "../../src/main/storage/stateService";

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

  it("returns empty state when file does not exist", () => {
    const svc = new StateService(path.join(tmpDir, "state.json"));
    expect(svc.getState()).toEqual({});
  });

  it("setState writes state.json and getState returns the merged value", () => {
    const filePath = path.join(tmpDir, "state.json");
    const svc = new StateService(filePath);
    svc.setState({ lastActiveWorkspaceId: "ws-1" });

    expect(svc.getState().lastActiveWorkspaceId).toBe("ws-1");
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.lastActiveWorkspaceId).toBe("ws-1");
  });

  it("atomic write — .vsctmp file is created then renamed (not left behind)", () => {
    const filePath = path.join(tmpDir, "state.json");
    const tmpPath = `${filePath}.vsctmp`;
    const svc = new StateService(filePath);
    svc.setState({ lastActiveWorkspaceId: "ws-2" });

    // The .vsctmp file must have been renamed away.
    expect(fs.existsSync(tmpPath)).toBe(false);
    // The final file must exist.
    expect(fs.existsSync(filePath)).toBe(true);
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

  it("creates parent directories if they do not exist", () => {
    const filePath = path.join(tmpDir, "nested", "deep", "state.json");
    const svc = new StateService(filePath);
    svc.setState({ lastActiveWorkspaceId: "ws-3" });
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("reads existing state.json on construction", () => {
    const filePath = path.join(tmpDir, "state.json");
    fs.writeFileSync(filePath, JSON.stringify({ lastActiveWorkspaceId: "ws-preexisting" }), "utf8");

    const svc = new StateService(filePath);
    expect(svc.getState().lastActiveWorkspaceId).toBe("ws-preexisting");
  });
});
