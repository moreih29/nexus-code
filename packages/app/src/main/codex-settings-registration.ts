import type { WorkspaceRegistryEntry } from "../../../shared/src/contracts/workspace";
import type { ClaudeSettingsConsentRequester } from "./claude-settings-registration";
import {
  CodexSettingsConsentStore,
  CodexSettingsManager,
  type CodexSettingsDetection,
} from "./codex-settings-manager";

export interface CodexSettingsRegistrationCoordinatorOptions {
  settingsManager: CodexSettingsManager;
  consentStore: CodexSettingsConsentStore;
  consentRequester: ClaudeSettingsConsentRequester;
}

export class CodexSettingsRegistrationCoordinator {
  public constructor(
    private readonly options: CodexSettingsRegistrationCoordinatorOptions,
  ) {}

  public async ensureRegistered(
    workspace: WorkspaceRegistryEntry,
  ): Promise<CodexSettingsDetection> {
    const registration = {
      workspaceId: workspace.id,
      workspacePath: workspace.absolutePath,
    };
    const existing = await this.options.settingsManager.detectExisting(registration);
    if (existing.nexusHookCount > 0 && existing.configEnablesHooks) {
      return existing;
    }

    const consent = await this.options.consentStore.get(workspace.id);
    if (consent?.dontAskAgain) {
      return this.options.settingsManager.register(registration);
    }

    const decision = await this.options.consentRequester.requestConsent({
      workspaceId: workspace.id,
      workspaceName: workspace.displayName,
      workspacePath: workspace.absolutePath,
      harnessName: "Codex",
      settingsFiles: [".codex/hooks.json", ".codex/config.toml"],
      settingsDescription:
        "Nexus Code는 Codex project-local hooks와 codex_hooks feature flag만 등록합니다.",
      gitignoreEntries: [".codex/hooks.json", ".codex/config.toml"],
    });

    if (!decision.approved) {
      return existing;
    }

    if (decision.dontAskAgain) {
      await this.options.consentStore.setDontAskAgain(workspace.id, true);
    }

    return this.options.settingsManager.register(registration);
  }

  public async unregister(workspace: WorkspaceRegistryEntry): Promise<CodexSettingsDetection> {
    return this.options.settingsManager.unregister({
      workspaceId: workspace.id,
      workspacePath: workspace.absolutePath,
    });
  }
}
