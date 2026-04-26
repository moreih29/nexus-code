import type { WorkspaceId } from "./workspace";

export interface ClaudeSettingsConsentRequest {
  requestId: string;
  workspaceId: WorkspaceId;
  workspaceName: string;
  workspacePath: string;
  harnessName?: string;
  settingsFiles?: string[];
  settingsDescription?: string;
  gitignoreEntries?: string[];
}

export interface ClaudeSettingsConsentResponse {
  requestId: string;
  approved: boolean;
  dontAskAgain: boolean;
}

type JsonObject = Record<string, unknown>;

export function isClaudeSettingsConsentResponse(
  value: unknown,
): value is ClaudeSettingsConsentResponse {
  if (!isJsonObject(value)) {
    return false;
  }

  return (
    typeof value.requestId === "string" &&
    value.requestId.trim().length > 0 &&
    typeof value.approved === "boolean" &&
    typeof value.dontAskAgain === "boolean"
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
