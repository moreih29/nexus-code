import type { RpcParams, RpcResult } from "../../../../../packages/remote-protocol/src";
import { tryGetMainT } from "../../../i18n";
import type { CliServices } from "../../cli/context";
import { type FolderSystem, folderToAdd, SYSTEM_FOLDERS } from "../folders";
import { unavailable } from "./common";

export async function createWorkspace(
  services: CliServices,
  { path: asked, name }: RpcParams<"workspace.create">,
  device: string | undefined,
  system: FolderSystem = SYSTEM_FOLDERS,
): Promise<RpcResult<"workspace.create">> {
  const rootPath = await folderToAdd(asked, system);
  const { workspace, added } = await services
    .addWorkspace({ kind: "local", rootPath }, name)
    .catch(unavailable);
  if (added) {
    const t = tryGetMainT();
    const from = device ?? "another device";
    const title = t ? String(t("common:remoteNotice.workspaceAdded", { device: from })) : "";
    services.notify(workspace.id, "", title || `Workspace added from ${from}`, rootPath);
  }
  return {
    workspace: { id: workspace.id, name: workspace.name, path: workspace.rootPath },
    created: added,
  };
}
