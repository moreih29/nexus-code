import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { WorkspaceId } from "../../../shared/src/contracts/workspace";
import {
  buildCodexHookCommands,
  CodexSettingsConsentStore,
  CodexSettingsManager,
} from "./codex-settings-manager";

async function withTempWorkspace<T>(run: (workspacePath: string, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexus-codex-settings-"));
  try {
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    return await run(workspacePath, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("CodexSettingsManager", () => {
  test("register creates project-local hooks, enables feature flag, gitignores, and backs up existing files once", async () => {
    await withTempWorkspace(async (workspacePath, root) => {
      const codexDir = path.join(workspacePath, ".codex");
      await mkdir(codexDir, { recursive: true });
      const hooksPath = path.join(codexDir, "hooks.json");
      const configPath = path.join(codexDir, "config.toml");
      await writeFile(
        hooksPath,
        JSON.stringify(
          {
            hooks: {
              PreToolUse: [
                {
                  matcher: "^Bash$",
                  hooks: [{ type: "command", command: "echo user-owned" }],
                },
              ],
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(configPath, "[features]\ncodex_hooks = false\n", "utf8");

      const manager = new CodexSettingsManager({
        sidecarBin: "/Applications/Nexus Code.app/Contents/Resources/nexus-sidecar",
        dataDir: path.join(root, "Application Support", "nexus-code"),
        now: () => new Date("2026-04-26T05:15:00.000Z"),
      });

      const detection = await manager.register({
        workspaceId: "ws_alpha" as WorkspaceId,
        workspacePath,
      });

      expect(detection.hooksExists).toBe(true);
      expect(detection.configExists).toBe(true);
      expect(detection.configEnablesHooks).toBe(true);
      expect(detection.nexusHookCount).toBe(6);
      expect(detection.gitignoreIncludesHooks).toBe(true);
      expect(detection.gitignoreIncludesConfig).toBe(true);

      const hooks = JSON.parse(await readFile(hooksPath, "utf8")) as {
        hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
      };
      expect(hooks.hooks.PreToolUse[0]?.hooks[0]?.command).toBe("echo user-owned");
      const nexusPreToolUse = hooks.hooks.PreToolUse.find((entry) => {
        return String(entry.hooks[0]?.command ?? "").includes("--adapter=codex");
      });
      expect(nexusPreToolUse?.matcher).toBe("*");
      expect(nexusPreToolUse?.hooks[0]).toMatchObject({
        type: "command",
        timeout: 5,
        statusMessage: "Nexus Code observer",
      });
      expect(String(nexusPreToolUse?.hooks[0]?.command)).toContain("hook --socket=");
      expect(String(nexusPreToolUse?.hooks[0]?.command)).toContain("--adapter=codex");
      expect(String(nexusPreToolUse?.hooks[0]?.command)).toContain("--event=PreToolUse");
      expect(hooks.hooks.PermissionRequest[0]?.matcher).toBe("*");
      expect(String(hooks.hooks.Stop[0]?.hooks[0]?.command)).toContain("--event=Stop");

      expect(await readFile(configPath, "utf8")).toContain("codex_hooks = true # nexus-code");
      expect(await readFile(path.join(workspacePath, ".gitignore"), "utf8")).toBe(
        ".codex/hooks.json\n.codex/config.toml\n",
      );
      expect((await readdir(codexDir)).filter((entry) => entry.includes("nexus-backup"))).toHaveLength(2);

      await manager.register({ workspaceId: "ws_alpha" as WorkspaceId, workspacePath });
      const hooksAfterSecondRegister = JSON.parse(await readFile(hooksPath, "utf8")) as {
        hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
      };
      const nexusCount = Object.values(hooksAfterSecondRegister.hooks)
        .flatMap((entries) => entries.flatMap((entry) => entry.hooks))
        .filter((hook) => String(hook.command ?? "").includes("--adapter=codex")).length;
      expect(nexusCount).toBe(6);
      expect((await readdir(codexDir)).filter((entry) => entry.includes("nexus-backup"))).toHaveLength(2);
    });
  });

  test("unregister removes only Nexus Codex hooks and marker feature flag", async () => {
    await withTempWorkspace(async (workspacePath, root) => {
      const manager = new CodexSettingsManager({
        sidecarBin: "/tmp/nexus-sidecar",
        dataDir: path.join(root, "userData"),
      });
      await manager.register({ workspaceId: "ws_alpha" as WorkspaceId, workspacePath });

      const hooksPath = path.join(workspacePath, ".codex", "hooks.json");
      const before = JSON.parse(await readFile(hooksPath, "utf8")) as Record<string, unknown>;
      before.keep = "user-value";
      await writeFile(hooksPath, `${JSON.stringify(before, null, 2)}\n`, "utf8");

      const detection = await manager.unregister({
        workspaceId: "ws_alpha" as WorkspaceId,
        workspacePath,
      });

      expect(detection.hooksExists).toBe(true);
      expect(detection.nexusHookCount).toBe(0);
      expect(detection.configEnablesHooks).toBe(false);
      const after = JSON.parse(await readFile(hooksPath, "utf8")) as Record<string, unknown>;
      expect(after.keep).toBe("user-value");
    });
  });

  test("buildCodexHookCommands quotes paths and uses workspace-specific socket path", () => {
    const commands = buildCodexHookCommands({
      sidecarBin: "/Applications/Nexus Code.app/nexus-sidecar",
      dataDir: "/Users/kih/Library/Application Support/nexus-code",
      workspaceId: "ws_alpha" as WorkspaceId,
    });

    expect(commands.PermissionRequest).toContain("'" + "/Applications/Nexus Code.app/nexus-sidecar" + "'");
    expect(commands.PermissionRequest).toContain("ws_alpha.sock");
    expect(commands.PermissionRequest).toContain("--adapter=codex");
    expect(commands.PermissionRequest).toContain("--event=PermissionRequest");
  });
});

describe("CodexSettingsConsentStore", () => {
  test("persists workspace scoped don't ask again consent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-codex-consent-"));
    try {
      const store = new CodexSettingsConsentStore({
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
