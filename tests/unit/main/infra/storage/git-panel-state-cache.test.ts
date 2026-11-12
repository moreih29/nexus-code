/**
 * WorkspaceStorage keeps each workspace's Source Control panel state once
 * read, for autofetch reads it every second: a write and a close drop it,
 * so a read after either sees what is stored.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceStorage } from "../../../../../src/main/infra/storage/workspace-storage";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function storage(): WorkspaceStorage {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-panel-cache-"));
  dirs.push(dir);
  return new WorkspaceStorage(dir, () => new Database(":memory:") as never);
}

describe("the Source Control panel state a workspace keeps", () => {
  test("is read once, and again after a write", () => {
    const s = storage();
    s.openForWorkspace("w");
    const first = s.getGitPanelState("w");
    expect(s.getGitPanelState("w")).toBe(first);
    s.setGitPanelState("w", { autofetchIntervalMin: 0, autofetchManualPaused: true });
    const after = s.getGitPanelState("w");
    expect(after).not.toBe(first);
    expect(after).toMatchObject({ autofetchIntervalMin: 0, autofetchManualPaused: true });
  });

  test("is dropped when the workspace closes", () => {
    const s = storage();
    s.openForWorkspace("w");
    s.setGitPanelState("w", { commitDraft: "draft" });
    expect(s.getGitPanelState("w").commitDraft).toBe("draft");
    s.closeForWorkspace("w");
    expect(() => s.getGitPanelState("w")).toThrow("not open");
  });
});
