import { app } from "electron";

export function getUserDataPath(): string {
  return app.getPath("userData");
}

export function getUserConfigPath(): string {
  return app.getPath("appData");
}

export function getWorkspaceStoragePath(workspaceId: string): string {
  return `${app.getPath("userData")}/workspaces/${workspaceId}`;
}
