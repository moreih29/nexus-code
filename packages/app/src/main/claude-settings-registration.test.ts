import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";

import { CLAUDE_SETTINGS_CONSENT_REQUEST_CHANNEL, CLAUDE_SETTINGS_CONSENT_RESPONSE_CHANNEL } from "../../../shared/src/contracts/ipc-channels";
import type { ClaudeSettingsConsentRequest, ClaudeSettingsConsentResponse } from "../../../shared/src/contracts/claude-settings";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace";
import type { WorkspaceRegistryEntry } from "../../../shared/src/contracts/workspace-registry";
import { ClaudeSettingsConsentStore, ClaudeSettingsManager } from "./claude-settings-manager";
import {
  ClaudeSettingsRegistrationCoordinator,
  RendererClaudeSettingsConsentRequester,
  type ClaudeSettingsConsentRequester,
} from "./claude-settings-registration";

describe("ClaudeSettingsRegistrationCoordinator", () => {
  test("prompts once and writes workspace-local settings after approval", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-claude-registration-"));
    try {
      const workspacePath = path.join(root, "alpha");
      await mkdir(workspacePath, { recursive: true });
      const workspace = createWorkspaceEntry({ workspacePath });
      const consentRequester = new FakeConsentRequester({
        requestId: "renderer-req",
        approved: true,
        dontAskAgain: true,
      });
      const coordinator = new ClaudeSettingsRegistrationCoordinator({
        settingsManager: new ClaudeSettingsManager({
          sidecarBin: "/tmp/nexus-sidecar",
          dataDir: path.join(root, "userData"),
        }),
        consentStore: new ClaudeSettingsConsentStore({ storageDir: root }),
        consentRequester,
      });

      const detection = await coordinator.ensureRegistered(workspace);

      expect(detection.nexusHookCount).toBe(5);
      expect(consentRequester.requests).toEqual([
        {
          workspaceId: workspace.id,
          workspaceName: workspace.displayName,
          workspacePath,
        },
      ]);
      await expect(
        readFile(path.join(workspacePath, ".claude", "settings.local.json"), "utf8"),
      ).resolves.toContain("nexus-code");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("RendererClaudeSettingsConsentRequester", () => {
  test("sends renderer request and resolves from IPC response", async () => {
    let handler: ((event: unknown, payload: unknown) => unknown) | null = null;
    const ipcMain = {
      handle: mock((channel: string, nextHandler: (event: unknown, payload: unknown) => unknown) => {
        expect(channel).toBe(CLAUDE_SETTINGS_CONSENT_RESPONSE_CHANNEL);
        handler = nextHandler;
      }),
      removeHandler: mock(() => undefined),
    };
    const sent: Array<{ channel: string; payload: ClaudeSettingsConsentRequest }> = [];
    const mainWindow = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: mock((channel: string, payload: ClaudeSettingsConsentRequest) => {
          sent.push({ channel, payload });
        }),
      },
    } as unknown as BrowserWindow;
    const requester = new RendererClaudeSettingsConsentRequester({
      ipcMain,
      mainWindow,
      createRequestId: () => "req-1",
      timeoutMs: 1_000,
    });

    const pending = requester.requestConsent({
      workspaceId: "ws_alpha" as WorkspaceId,
      workspaceName: "Alpha",
      workspacePath: "/tmp/alpha",
    });

    expect(sent).toEqual([
      {
        channel: CLAUDE_SETTINGS_CONSENT_REQUEST_CHANNEL,
        payload: {
          requestId: "req-1",
          workspaceId: "ws_alpha",
          workspaceName: "Alpha",
          workspacePath: "/tmp/alpha",
        },
      },
    ]);

    handler?.({}, {
      requestId: "req-1",
      approved: true,
      dontAskAgain: false,
    });

    await expect(pending).resolves.toEqual({
      requestId: "req-1",
      approved: true,
      dontAskAgain: false,
    });
    requester.dispose();
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(CLAUDE_SETTINGS_CONSENT_RESPONSE_CHANNEL);
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
