import { randomUUID } from "node:crypto";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";

import {
  CLAUDE_SETTINGS_CONSENT_REQUEST_CHANNEL,
  CLAUDE_SETTINGS_CONSENT_RESPONSE_CHANNEL,
} from "../../../shared/src/contracts/ipc-channels";
import {
  isClaudeSettingsConsentResponse,
  type ClaudeSettingsConsentRequest,
  type ClaudeSettingsConsentResponse,
} from "../../../shared/src/contracts/claude-settings";
import type { WorkspaceRegistryEntry } from "../../../shared/src/contracts/workspace";
import {
  ClaudeSettingsConsentStore,
  ClaudeSettingsManager,
  type ClaudeSettingsDetection,
} from "./claude-settings-manager";

export interface ClaudeSettingsRegistrationCoordinatorOptions {
  settingsManager: ClaudeSettingsManager;
  consentStore: ClaudeSettingsConsentStore;
  consentRequester: ClaudeSettingsConsentRequester;
}

export interface ClaudeSettingsConsentRequester {
  requestConsent(
    request: Omit<ClaudeSettingsConsentRequest, "requestId">,
  ): Promise<ClaudeSettingsConsentResponse>;
}

export class ClaudeSettingsRegistrationCoordinator {
  public constructor(
    private readonly options: ClaudeSettingsRegistrationCoordinatorOptions,
  ) {}

  public async ensureRegistered(
    workspace: WorkspaceRegistryEntry,
  ): Promise<ClaudeSettingsDetection> {
    const registration = {
      workspaceId: workspace.id,
      workspacePath: workspace.absolutePath,
    };
    const existing = await this.options.settingsManager.detectExisting(registration);
    if (existing.nexusHookCount > 0) {
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
      harnessName: "Claude Code",
      settingsFiles: [".claude/settings.local.json"],
      settingsDescription:
        "Nexus Code는 Claude Code workspace-local settings hook만 등록합니다.",
      gitignoreEntries: [".claude/settings.local.json"],
    });

    if (!decision.approved) {
      return existing;
    }

    if (decision.dontAskAgain) {
      await this.options.consentStore.setDontAskAgain(workspace.id, true);
    }

    return this.options.settingsManager.register(registration);
  }

  public async unregister(workspace: WorkspaceRegistryEntry): Promise<ClaudeSettingsDetection> {
    return this.options.settingsManager.unregister({
      workspaceId: workspace.id,
      workspacePath: workspace.absolutePath,
    });
  }
}

export interface RendererClaudeSettingsConsentRequesterOptions {
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  mainWindow: BrowserWindow;
  timeoutMs?: number;
  createRequestId?: () => string;
}

interface PendingConsentRequest {
  resolve(response: ClaudeSettingsConsentResponse): void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_CONSENT_TIMEOUT_MS = 5 * 60 * 1000;

export class RendererClaudeSettingsConsentRequester implements ClaudeSettingsConsentRequester {
  private readonly pendingByRequestId = new Map<string, PendingConsentRequest>();
  private readonly timeoutMs: number;
  private readonly createRequestId: () => string;
  private disposed = false;

  public constructor(private readonly options: RendererClaudeSettingsConsentRequesterOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CONSENT_TIMEOUT_MS;
    this.createRequestId = options.createRequestId ?? randomUUID;

    this.options.ipcMain.handle(
      CLAUDE_SETTINGS_CONSENT_RESPONSE_CHANNEL,
      (_event: IpcMainInvokeEvent, payload: unknown) => this.handleConsentResponse(payload),
    );
  }

  public requestConsent(
    request: Omit<ClaudeSettingsConsentRequest, "requestId">,
  ): Promise<ClaudeSettingsConsentResponse> {
    if (this.disposed || this.options.mainWindow.isDestroyed()) {
      return Promise.resolve(createCancelResponse("disposed"));
    }

    const webContents = this.options.mainWindow.webContents;
    if (webContents.isDestroyed()) {
      return Promise.resolve(createCancelResponse("destroyed"));
    }

    const requestId = this.createRequestId();
    const payload: ClaudeSettingsConsentRequest = {
      requestId,
      ...request,
    };

    return new Promise<ClaudeSettingsConsentResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingByRequestId.delete(requestId);
        resolve(createCancelResponse(requestId));
      }, this.timeoutMs);
      const timerWithUnref = timer as { unref?: () => void };
      timerWithUnref.unref?.();

      this.pendingByRequestId.set(requestId, { resolve, timer });
      webContents.send(CLAUDE_SETTINGS_CONSENT_REQUEST_CHANNEL, payload);
    });
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.options.ipcMain.removeHandler(CLAUDE_SETTINGS_CONSENT_RESPONSE_CHANNEL);

    for (const [requestId, pending] of this.pendingByRequestId) {
      clearTimeout(pending.timer);
      pending.resolve(createCancelResponse(requestId));
    }
    this.pendingByRequestId.clear();
  }

  private handleConsentResponse(payload: unknown): null {
    if (!isClaudeSettingsConsentResponse(payload)) {
      return null;
    }

    const pending = this.pendingByRequestId.get(payload.requestId);
    if (!pending) {
      return null;
    }

    clearTimeout(pending.timer);
    this.pendingByRequestId.delete(payload.requestId);
    pending.resolve(payload);
    return null;
  }
}

function createCancelResponse(requestId: string): ClaudeSettingsConsentResponse {
  return {
    requestId,
    approved: false,
    dontAskAgain: false,
  };
}
