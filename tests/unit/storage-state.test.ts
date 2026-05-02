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

  it("sidebarWidth round-trip: write 320 then read back 320", () => {
    const filePath = path.join(tmpDir, "state.json");
    const svc = new StateService(filePath);
    svc.setState({ sidebarWidth: 320 });

    const svc2 = new StateService(filePath);
    expect(svc2.getState().sidebarWidth).toBe(320);
  });

  it("sidebarWidth partial-merge: setting only sidebarWidth preserves existing windowBounds", () => {
    const filePath = path.join(tmpDir, "state.json");
    const svc = new StateService(filePath);
    svc.setState({ windowBounds: { x: 10, y: 20, width: 1440, height: 900 } });
    svc.setState({ sidebarWidth: 240 });

    const state = svc.getState();
    expect(state.sidebarWidth).toBe(240);
    expect(state.windowBounds?.width).toBe(1440);
  });

  it("sidebarWidth invalid type: string value rejected by zod", () => {
    const filePath = path.join(tmpDir, "state.json");
    const svc = new StateService(filePath);
    expect(() => svc.setState({ sidebarWidth: "wide" as unknown as number })).toThrow();
  });

  it("sidebarWidth invalid type: negative value rejected by zod", () => {
    const filePath = path.join(tmpDir, "state.json");
    const svc = new StateService(filePath);
    expect(() => svc.setState({ sidebarWidth: -1 })).toThrow();
  });

  it("loads on-disk state without sidebarWidth without error", () => {
    const filePath = path.join(tmpDir, "state.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        lastActiveWorkspaceId: "ws-old",
        windowBounds: { x: 0, y: 0, width: 800, height: 600 },
      }),
      "utf8",
    );

    const svc = new StateService(filePath);
    const state = svc.getState();
    expect(state.sidebarWidth).toBeUndefined();
    expect(state.lastActiveWorkspaceId).toBe("ws-old");
  });
});
