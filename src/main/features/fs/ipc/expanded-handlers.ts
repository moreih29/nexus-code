/**
 * fs expanded-folder handlers — renderer tree state persisted per workspace.
 */
import { ipcContract } from "../../../../shared/ipc-contract";
import type { WorkspaceStorage } from "../../../storage/workspace-storage";
import type { WorkspaceManager } from "../../workspace/manager";
import { validateArgs } from "../../../ipc/router";
import { assertWorkspaceExists } from "../../workspace/path-safety";

const c = ipcContract.fs.call;

export function getExpandedHandler(
  manager: WorkspaceManager,
  storage: WorkspaceStorage,
): (args: unknown) => Promise<{ relPaths: string[] }> {
  return async (args: unknown): Promise<{ relPaths: string[] }> => {
    const { workspaceId } = validateArgs(c.getExpanded.args, args);
    assertWorkspaceExists(manager, workspaceId);
    const relPaths = storage.getExpandedPaths(workspaceId);
    return { relPaths };
  };
}

export function setExpandedHandler(
  manager: WorkspaceManager,
  storage: WorkspaceStorage,
): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, relPaths } = validateArgs(c.setExpanded.args, args);
    assertWorkspaceExists(manager, workspaceId);
    storage.setExpandedPaths(workspaceId, relPaths);
  };
}
