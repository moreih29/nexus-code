import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ClaudeSettingsConsentRequest, ClaudeSettingsConsentResponse } from "../../../../shared/src/contracts/claude/claude-settings";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { WorkspaceRegistryEntry } from "../../../../shared/src/contracts/workspace/workspace-registry";
import type { ClaudeSettingsConsentRequester } from "../claude/claude-settings-registration";
import { CodexSettingsConsentStore, CodexSettingsManager } from "./codex-settings-manager";
import { CodexSettingsRegistrationCoordinator } from "./codex-settings-registration";

describe("CodexSettingsRegistrationCoordinator", () => {
  test("prompts once and writes Codex project-local hooks/config after approval", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-codex-registration-"));
    try {
      const workspacePath = path.join(root, "alpha");
      await mkdir(workspacePath, { recursive: true });
      const workspace = createWorkspaceEntry({ workspacePath });
      const consentRequester = new FakeConsentRequester({
        requestId: "renderer-req",
        approved: true,
        dontAskAgain: true,
      });
      const coordinator = new CodexSettingsRegistrationCoordinator({
        settingsManager: new CodexSettingsManager({
          sidecarBin: "/tmp/nexus-sidecar",
          dataDir: path.join(root, "userData"),
        }),
        consentStore: new CodexSettingsConsentStore({ storageDir: root }),
        consentRequester,
      });

      const detection = await coordinator.ensureRegistered(workspace);

      expect(detection.nexusHookCount).toBe(6);
      expect(detection.configEnablesHooks).toBe(true);
      expect(consentRequester.requests).toEqual([
        {
          workspaceId: workspace.id,
          workspaceName: workspace.displayName,
          workspacePath,
          harnessName: "Codex",
          settingsFiles: [".codex/hooks.json", ".codex/config.toml"],
          settingsDescription:
            "Nexus Code는 Codex project-local hooks와 codex_hooks feature flag만 등록합니다.",
          gitignoreEntries: [".codex/hooks.json", ".codex/config.toml"],
        },
      ]);
      await expect(readFile(path.join(workspacePath, ".codex", "hooks.json"), "utf8")).resolves.toContain("--adapter=codex");
      await expect(readFile(path.join(workspacePath, ".codex", "config.toml"), "utf8")).resolves.toContain("codex_hooks = true");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function createWorkspaceEntry(options: { workspacePath: string }): WorkspaceRegistryEntry {
  return {
    id: "ws_alpha" as WorkspaceId,
    absolutePath: options.workspacePath,
    displayName: "Alpha",
    createdAt: "2026-04-26T05:15:00.000Z",
    lastOpenedAt: "2026-04-26T05:15:00.000Z",
  };
}

class FakeConsentRequester implements ClaudeSettingsConsentRequester {
  public readonly requests: Array<Omit<ClaudeSettingsConsentRequest, "requestId">> = [];

  public constructor(private readonly response: ClaudeSettingsConsentResponse) {}

  public async requestConsent(
    request: Omit<ClaudeSettingsConsentRequest, "requestId">,
  ): Promise<ClaudeSettingsConsentResponse> {
    this.requests.push(request);
    return this.response;
  }
}
