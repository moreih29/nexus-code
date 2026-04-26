import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { WorkspaceId } from "../../../shared/src/contracts/workspace";
import {
  buildHookCommands,
  ClaudeSettingsConsentStore,
  ClaudeSettingsManager,
} from "./claude-settings-manager";

async function withTempWorkspace<T>(run: (workspacePath: string, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexus-claude-settings-"));
  try {
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    return await run(workspacePath, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("ClaudeSettingsManager", () => {
  test("register creates workspace-local settings, gitignore, and preserves user hooks with one backup", async () => {
    await withTempWorkspace(async (workspacePath, root) => {
      const claudeDir = path.join(workspacePath, ".claude");
      await mkdir(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, "settings.local.json");
      await writeFile(
        settingsPath,
        JSON.stringify(
          {
            hooks: {
              PreToolUse: [
                {
                  matcher: "Bash",
                  hooks: [{ type: "command", command: "echo user-owned" }],
                },
              ],
            },
          },
          null,
          2,
        ),
      );

      const manager = new ClaudeSettingsManager({
        sidecarBin: "/Applications/Nexus Code.app/Contents/Resources/nexus-sidecar",
        dataDir: path.join(root, "Application Support", "nexus-code"),
        now: () => new Date("2026-04-26T05:15:00.000Z"),
      });

      const detection = await manager.register({
        workspaceId: "ws_alpha" as WorkspaceId,
        workspacePath,
      });

      expect(detection.exists).toBe(true);
      expect(detection.nexusHookCount).toBe(5);
      expect(detection.gitignoreIncludesSettings).toBe(true);

      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
      };
      expect(settings.hooks.PreToolUse[0]?.hooks[0]?.command).toBe("echo user-owned");
      const nexusPreToolUse = settings.hooks.PreToolUse.find((entry) => entry.hooks[0]?.source === "nexus-code");
      expect(nexusPreToolUse?.matcher).toBe("*");
      expect(nexusPreToolUse?.hooks[0]).toMatchObject({
        type: "command",
        source: "nexus-code",
        timeout: 5,
      });
      expect(String(nexusPreToolUse?.hooks[0]?.command)).toContain("hook --socket=");
      expect(String(nexusPreToolUse?.hooks[0]?.command)).toContain("--adapter=claude-code");
      expect(String(nexusPreToolUse?.hooks[0]?.command)).toContain("--event=PreToolUse");

      expect(await readFile(path.join(workspacePath, ".gitignore"), "utf8")).toContain(
        ".claude/settings.local.json",
      );
      const backups = (await readdir(claudeDir)).filter((entry) => entry.includes("nexus-backup"));
      expect(backups).toHaveLength(1);

      await manager.register({ workspaceId: "ws_alpha" as WorkspaceId, workspacePath });
      const settingsAfterSecondRegister = JSON.parse(await readFile(settingsPath, "utf8")) as {
        hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
      };
      const nexusCount = Object.values(settingsAfterSecondRegister.hooks)
        .flatMap((entries) => entries.flatMap((entry) => entry.hooks))
        .filter((hook) => hook.source === "nexus-code").length;
      expect(nexusCount).toBe(5);
      expect((await readdir(claudeDir)).filter((entry) => entry.includes("nexus-backup"))).toHaveLength(1);
    });
  });

  test("unregister removes only nexus-code marker hooks and preserves user settings file", async () => {
    await withTempWorkspace(async (workspacePath, root) => {
      const manager = new ClaudeSettingsManager({
        sidecarBin: "/tmp/nexus-sidecar",
        dataDir: path.join(root, "userData"),
      });
      await manager.register({ workspaceId: "ws_alpha" as WorkspaceId, workspacePath });

      const settingsPath = path.join(workspacePath, ".claude", "settings.local.json");
      const before = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
      before.keep = "user-value";
      await writeFile(settingsPath, `${JSON.stringify(before, null, 2)}\n`, "utf8");

      const detection = await manager.unregister({
        workspaceId: "ws_alpha" as WorkspaceId,
        workspacePath,
      });

      expect(detection.exists).toBe(true);
      expect(detection.nexusHookCount).toBe(0);
      const after = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
      expect(after.keep).toBe("user-value");
    });
  });

  test("consent flow registers exact workspace-local shape then unregisters marker hooks", async () => {
    await withTempWorkspace(async (workspacePath, root) => {
      const workspaceId = "ws_consent" as WorkspaceId;
      const consentStore = new ClaudeSettingsConsentStore({ storageDir: root });
      await consentStore.setDontAskAgain(workspaceId, true);
      expect((await consentStore.get(workspaceId))?.dontAskAgain).toBe(true);

      const manager = new ClaudeSettingsManager({
        sidecarBin: "/tmp/nexus-sidecar",
        dataDir: path.join(root, "userData"),
        now: () => new Date("2026-04-26T05:15:00.000Z"),
      });

      await manager.register({ workspaceId, workspacePath });

      const settingsPath = path.join(workspacePath, ".claude", "settings.local.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
      };
      expect(settings.hooks.PreToolUse).toEqual([
        {
          matcher: "*",
          source: "nexus-code",
          hooks: [
            {
              type: "command",
              command: expect.any(String),
              timeout: 5,
              source: "nexus-code",
            },
          ],
        },
      ]);
      expect(String(settings.hooks.PreToolUse[0]?.hooks[0]?.command)).toContain("--adapter=claude-code");
      expect(String(settings.hooks.PreToolUse[0]?.hooks[0]?.command)).toContain("--event=PreToolUse");
      expect(settings.hooks.Notification[0]?.hooks[0]?.command).toEqual(
        expect.stringContaining("--event=Notification"),
      );
      expect(await readFile(path.join(workspacePath, ".gitignore"), "utf8")).toBe(
        ".claude/settings.local.json\n",
      );
      expect((await readdir(path.join(workspacePath, ".claude"))).filter((entry) => entry.includes("nexus-backup"))).toHaveLength(0);

      await manager.unregister({ workspaceId, workspacePath });
      const after = JSON.parse(await readFile(settingsPath, "utf8")) as {
        hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
      };
      const markerHooks = Object.values(after.hooks)
        .flatMap((entries) => entries.flatMap((entry) => entry.hooks))
        .filter((hook) => hook.source === "nexus-code");
      expect(markerHooks).toEqual([]);
    });
  });

  test("buildHookCommands quotes paths and uses workspace-specific socket path", () => {
    const commands = buildHookCommands({
      sidecarBin: "/Applications/Nexus Code.app/nexus-sidecar",
      dataDir: "/Users/kih/Library/Application Support/nexus-code",
      workspaceId: "ws_alpha" as WorkspaceId,
    });

    expect(commands.Notification).toContain("'" + "/Applications/Nexus Code.app/nexus-sidecar" + "'");
    expect(commands.Notification).toContain("ws_alpha.sock");
    expect(commands.Notification).toContain("--adapter=claude-code");
    expect(commands.Notification).toContain("--event=Notification");
  });
});

describe("ClaudeSettingsConsentStore", () => {
  test("persists workspace scoped don't ask again consent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-claude-consent-"));
    try {
      const store = new ClaudeSettingsConsentStore({
        storageDir: root,
        now: () => new Date("2026-04-26T05:15:00.000Z"),
      });

      expect(await store.get("ws_alpha" as WorkspaceId)).toBeNull();
      await store.setDontAskAgain("ws_alpha" as WorkspaceId, true);
      await expect(store.get("ws_alpha" as WorkspaceId)).resolves.toEqual({
        workspaceId: "ws_alpha",
        dontAskAgain: true,
        updatedAt: "2026-04-26T05:15:00.000Z",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
