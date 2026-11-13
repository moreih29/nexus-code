/**
 * A terminal's controls as another device uses them (terminal.input,
 * terminal.shells, terminal.open, terminal.rename, terminal.close), served
 * only while the user lets other devices control this computer's
 * terminals (Settings › Remote); and the answer to a terminal's Claude
 * Code request (terminal.answer), which is a chat's control.
 */
import {
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
} from "../../../../packages/remote-protocol/src";
import type { CliServices } from "../cli/context";
import { keySequence } from "../cli/keys";
import type { FsProvider } from "../fs/bridge/provider";
import { folderIn } from "./files";
import { RpcFailure } from "./room";
import { tabOf, unavailable, workspaceOf } from "./serve";

/** Types into the terminal: the text pasted, then the keys, then Enter; when it was typed. */
export async function inputTerminal(
  services: CliServices,
  { workspaceId, tabId, text, keys, enter, from }: RpcParams<"terminal.input">,
  now: () => number = Date.now,
): Promise<RpcResult<"terminal.input">> {
  if (!text && !keys?.length && !enter) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, "nothing to type: text, keys or enter");
  }
  await tabOf(services, workspaceId, tabId, ["terminal"]);
  const at = now();
  const type = (typed: string, mode: "paste" | "keys", andEnter: boolean) =>
    services
      .ui("terminal.input", { workspaceId, tabId, text: typed, mode, enter: andEnter })
      .catch(unavailable);
  if (keys?.length) {
    if (text) await type(text, "paste", false);
    await type(keys.map(keySequence).join(""), "keys", enter ?? false);
  } else {
    await type(text ?? "", "paste", enter ?? false);
  }
  // An agent's input: the turn it starts here is down the chain from it.
  if (from) services.agentInputs.record(workspaceId, tabId, from.hops, at);
  return { at };
}

/** The shells a new terminal can run, the default marked. */
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

/** Opens a terminal behind what the window shows: in a folder of the workspace, a shell, a command. */
export async function openTerminal(
  services: CliServices,
  { workspaceId, shell, folder, command, title }: RpcParams<"terminal.open">,
  fs?: (workspaceId: string) => Promise<FsProvider>,
): Promise<RpcResult<"terminal.open">> {
  const workspace = workspaceOf(services, workspaceId);
  if (!workspace) throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
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
      // Behind what the window shows: whoever sits at this computer keeps their place.
      placement: { background: true },
    })
    .catch(unavailable);
}

export async function renameTerminal(
  services: CliServices,
  { workspaceId, tabId, title }: RpcParams<"terminal.rename">,
): Promise<RpcResult<"terminal.rename">> {
  await tabOf(services, workspaceId, tabId, ["terminal"]);
  if (!title.trim()) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, "a title needs more than spaces");
  }
  return services.ui("tab.rename", { workspaceId, tabId, title: title.trim() }).catch(unavailable);
}

/** Closes the terminal; one running a program only when `force`. */
export async function closeTerminal(
  services: CliServices,
  { workspaceId, tabId, force }: RpcParams<"terminal.close">,
): Promise<RpcResult<"terminal.close">> {
  await tabOf(services, workspaceId, tabId, ["terminal"]);
  await services.ui("tab.close", { workspaceId, tabId, force: force ?? false }).catch(unavailable);
  return {};
}

/** Answers the request a terminal's Claude Code holds, as the app's card does. */
export async function answerTerminal(
  services: CliServices,
  { workspaceId, tabId, requestId, decision }: RpcParams<"terminal.answer">,
): Promise<RpcResult<"terminal.answer">> {
  await tabOf(services, workspaceId, tabId, ["terminal"]);
  const ask = services.claudeAsks(workspaceId, tabId).find((a) => a.id === requestId);
  if (!ask) {
    throw new RpcFailure(RpcErrorCode.NotFound, "that request no longer waits for an answer");
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
