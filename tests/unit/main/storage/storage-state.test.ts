import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateService } from "../../../../src/main/infra/storage/state-service";

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

  it("backs up a state file that is not valid JSON", () => {
    const filePath = path.join(tmpDir, "state.json");
    fs.writeFileSync(filePath, "{ truncated", "utf8");

    const state = new StateService(filePath).getState();

    expect(state.updateChannel).toBe("stable");
    expect(fs.readFileSync(`${filePath}.invalid`, "utf8")).toBe("{ truncated");
  });
});
