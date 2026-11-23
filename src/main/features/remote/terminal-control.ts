import {
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
} from "../../../../packages/remote-protocol/src";
import type { TerminalOpener } from "../../../shared/chat/relay";
import type { CliServices } from "../cli/context";
import { keySequence } from "../cli/keys";
import type { FsProvider } from "../fs/bridge/provider";
import { folderIn } from "./files";
import { RpcFailure } from "./room";
import { tabOf, unavailable, workspaceOf } from "./serving/common";

export async function inputTerminal(
  services: CliServices,
  { workspaceId, tabId, text, typed, keys, enter, from }: RpcParams<"terminal.input">,
  now: () => number = Date.now,
): Promise<RpcResult<"terminal.input">> {
  if (!text && !keys?.length && !enter) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, "nothing to type: text, keys or enter");
  }
  await tabOf(services, workspaceId, tabId, ["terminal"]);
  const at = now();
  const type = (typed: string, mode: "paste" | "keys", andEnter: boolean) => {
    if (
      from &&
      (services.claudeStatus(workspaceId, tabId)?.status === "permissionPending" ||
        services.claudeAsks(workspaceId, tabId).length > 0)
    ) {
      throw new RpcFailure(
        RpcErrorCode.Forbidden,
        "that request is for the user to answer in the app",
      );
    }
    return services
      .ui("terminal.input", { workspaceId, tabId, text: typed, mode, enter: andEnter })
      .catch(unavailable);
  };
  const mode = typed ? "keys" : "paste";
  const given = typed ? (text ?? "").replace(/\r?\n/g, "\r") : (text ?? "");
  if (keys?.length) {
    if (given) await type(given, mode, false);
    await type(keys.map(keySequence).join(""), "keys", enter ?? false);
  } else {
    await type(given, mode, enter ?? false);
  }
  return { at };
}

export async function terminalShells(
  services: CliServices,
  { workspaceId }: RpcParams<"terminal.shells">,
): Promise<RpcResult<"terminal.shells">> {
  if (!workspaceOf(services, workspaceId)) {
    throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
  }
  const { shells } = await services.ui("terminal.shells", {}).catch(unavailable);
  return { shells: shells.map(({ id, name, isDefault }) => ({ id, name, isDefault })) };
}

async function profileIdOf(services: CliServices, profile: string): Promise<string> {
  const { profiles } = await services.ui("chat.profiles", {}).catch(unavailable);
  const byId = profiles.find((p) => p.id === profile);
  if (byId) return byId.id;
  const wanted = profile.trim().toLowerCase();
  const named = profiles.filter((p) => p.name.trim().toLowerCase() === wanted);
  if (named.length === 1 && named[0]) return named[0].id;
  throw new RpcFailure(
    RpcErrorCode.InvalidParams,
    named.length > 1
      ? `more than one profile is named "${profile}"; give its id: ${named.map((p) => p.id).join(", ")}`
      : `no profile "${profile}"; there are ${profiles.map((p) => p.id).join(", ")}`,
  );
}

export async function openTerminal(
  services: CliServices,
  { workspaceId, shell, folder, command, title, profile }: RpcParams<"terminal.open">,
  fs?: (workspaceId: string) => Promise<FsProvider>,
  openedBy?: TerminalOpener,
): Promise<RpcResult<"terminal.open">> {
  const workspace = workspaceOf(services, workspaceId);
  if (!workspace) throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
  const profileId = profile !== undefined ? await profileIdOf(services, profile) : undefined;
  const cwd = folder
    ? await folderIn(
        fs ? await fs(workspaceId).catch(unavailable) : null,
        workspace.rootPath,
        folder,
      )
    : workspace.rootPath;
  return services
    .ui("terminal.open", {
      workspaceId,
      cwd,
      ...(title ? { title } : {}),
      ...(command ? { command } : {}),
      ...(shell ? { shell } : {}),
      ...(profileId !== undefined ? { profile: profileId } : {}),
      placement: { background: true },
      ...(openedBy ? { openedBy } : {}),
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (/^no profile /.test(message)) throw new RpcFailure(RpcErrorCode.InvalidParams, message);
      return unavailable(error);
    });
}

export async function renameTerminal(
  services: CliServices,
  { workspaceId, tabId, title, from }: RpcParams<"terminal.rename">,
): Promise<RpcResult<"terminal.rename">> {
  await tabOf(services, workspaceId, tabId, ["terminal"]);
  if (!from && !title.trim())
    throw new RpcFailure(RpcErrorCode.InvalidParams, "a title needs more than spaces");
  return services.ui("tab.rename", { workspaceId, tabId, title: title.trim() }).catch(unavailable);
}

export async function closeTerminal(
  services: CliServices,
  { workspaceId, tabId, force }: RpcParams<"terminal.close">,
): Promise<RpcResult<"terminal.close">> {
  await tabOf(services, workspaceId, tabId, ["terminal"]);
  await services.ui("tab.close", { workspaceId, tabId, force: force ?? false }).catch(unavailable);
  return {};
}

export async function answerTerminal(
  services: CliServices,
  { workspaceId, tabId, requestId, decision, from }: RpcParams<"terminal.answer">,
): Promise<RpcResult<"terminal.answer">> {
  await tabOf(services, workspaceId, tabId, ["terminal"]);
  const ask = services.claudeAsks(workspaceId, tabId).find((a) => a.id === requestId);
  if (!ask) {
    throw new RpcFailure(RpcErrorCode.NotFound, "that request no longer waits for an answer");
  }
  if (from && (ask.tool === "AskUserQuestion" || ask.tool === "ExitPlanMode")) {
    throw new RpcFailure(
      RpcErrorCode.Forbidden,
      "that request is for the user to answer in the app",
    );
  }
  const answered = await services
    .answerClaudeAsk(workspaceId, tabId, requestId, decision)
    .catch(unavailable);
  if (!answered) {
    throw new RpcFailure(
      RpcErrorCode.InvalidParams,
      decision === "allowAlways"
        ? "that request suggests nothing to allow always"
        : decision === "denyStop"
          ? "a subagent's request cannot stop the turn"
          : "that request no longer waits for an answer",
    );
  }
  return {};
}
