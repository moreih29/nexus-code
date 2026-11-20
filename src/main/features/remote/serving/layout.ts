import { RpcErrorCode, type RpcParams } from "../../../../../packages/remote-protocol/src";
import type { CliServices } from "../../cli/context";
import { rendererRoot } from "../../cli/paths";
import type { FsProvider } from "../../fs/bridge/provider";
import { guardPeerViewFile } from "../../fs/read-guard";
import { placeOf, validatePathParts } from "../files";
import { RpcFailure } from "../room";
import { fitsAsResult, unavailable, workspaceOf } from "./common";

function checkedWorkspace(services: CliServices, workspaceId: string) {
  const workspace = workspaceOf(services, workspaceId);
  if (!workspace) throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
  return workspace;
}

function fits<T>(result: T): T {
  if (!fitsAsResult(result))
    throw new RpcFailure(RpcErrorCode.Unavailable, "the layout exceeds one frame");
  return result;
}

export async function readLayout(services: CliServices, workspaceId: string) {
  checkedWorkspace(services, workspaceId);
  const [layout, { tabs }] = await Promise.all([
    services.ui("layout.get", { workspaceId }),
    services.ui("tabs.list", { workspaceId }),
  ]).catch(unavailable);
  return fits({
    ...layout,
    tabs: tabs.map(({ id, groupId, type, title, shown }) => ({ id, groupId, type, title, shown })),
  });
}

export async function changeLayout(
  services: CliServices,
  { workspaceId, change }: RpcParams<"layout.change">,
  terminal: boolean,
) {
  checkedWorkspace(services, workspaceId);
  switch (change.op) {
    case "split":
      return services
        .ui("layout.split", {
          workspaceId,
          tabId: change.tabId,
          groupId: change.groupId,
          side: change.side,
        })
        .catch(unavailable);
    case "move":
      return services
        .ui("tab.move", {
          workspaceId,
          tabId: change.tabId,
          groupId: change.groupId,
          ...(change.index === undefined ? {} : { index: change.index }),
        })
        .catch(unavailable);
    case "ratios":
      return services
        .ui("layout.ratios", { workspaceId, ratios: change.ratios })
        .catch(unavailable);
    case "close":
      // The group can contain terminals, regardless of their current state.
      if (!terminal)
        throw new RpcFailure(RpcErrorCode.Forbidden, "closing groups requires terminal control");
      return services
        .ui("group.close", {
          workspaceId,
          groupId: change.groupId,
          force: change.force,
        })
        .catch(unavailable);
    case "focus":
      return services
        .ui("layout.focus", { workspaceId, groupId: change.groupId })
        .catch(unavailable);
  }
}

export async function readAgentView(services: CliServices) {
  return fits(await services.ui("agentView.get", {}).catch(unavailable));
}

export async function changeAgentView(
  services: CliServices,
  { workspaceId, change }: RpcParams<"agentView.change">,
  fs?: (workspaceId: string) => Promise<FsProvider>,
) {
  const workspace = checkedWorkspace(services, workspaceId);
  switch (change.op) {
    case "show":
      return services.ui("agentView.show", { view: change.view }).catch(unavailable);
    case "group":
      return services.ui("agentView.group", { grouping: change.grouping }).catch(unavailable);
    case "place": {
      const { op: _, tab, ...placement } = change;
      if ("workspaceId" in tab && tab.workspaceId !== workspaceId)
        throw new RpcFailure(RpcErrorCode.InvalidParams, "choose the session's workspace");
      return services.ui("agentView.place", { ...tab, ...placement }).catch(unavailable);
    }
    case "remove": {
      if ("workspaceId" in change.tab && change.tab.workspaceId !== workspaceId)
        throw new RpcFailure(RpcErrorCode.InvalidParams, "choose the session's workspace");
      return services.ui("agentView.remove", change.tab).catch(unavailable);
    }
    case "openFile": {
      const file = placeOf(workspace.rootPath, [], change.path);
      if (file.kind !== "workspace" || !file.rel)
        throw new RpcFailure(RpcErrorCode.InvalidParams, "choose a file inside the workspace");
      validatePathParts(workspace.rootPath, file.rel);
      const provider = await fs?.(workspaceId).catch(unavailable);
      if (!provider?.readRangeNoLinks)
        throw new RpcFailure(RpcErrorCode.Unavailable, "secure file reads are unavailable");
      const verified = await provider.readRangeNoLinks(file.rel, 0, 0).catch(unavailable);
      if (verified.kind !== "ok") throw new RpcFailure(RpcErrorCode.NotFound, "no such file");
      if (checkedWorkspace(services, workspaceId).rootPath !== workspace.rootPath)
        throw new RpcFailure(RpcErrorCode.NotFound, "the workspace moved");
      guardPeerViewFile(workspaceId, workspace.rootPath, file.rel);
      return services
        .ui("agentView.openFile", {
          workspaceId,
          filePath: `${rendererRoot(workspace)}/${file.rel}`,
          ...(change.panelId ? { panelId: change.panelId } : {}),
        })
        .catch(unavailable);
    }
    case "close":
      return services.ui("agentView.close", { panelId: change.panelId }).catch(unavailable);
    case "focus":
      return services.ui("agentView.focus", { panelId: change.panelId }).catch(unavailable);
    case "ratios":
      return services.ui("agentView.ratios", { ratios: change.ratios }).catch(unavailable);
  }
}
