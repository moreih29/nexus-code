import { posix, win32 } from "node:path";
import {
  MAX_FILE_SUGGESTIONS,
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
} from "../../../../../packages/remote-protocol/src";
import type { RelaySender, TerminalOpener } from "../../../../shared/chat/relay";
import type { CliChatChoices } from "../../../../shared/cli/ui";
import { CHAT_MODES, chatModeNamed } from "../../../../shared/sessions/chat-modes";
import type { ChatAgent } from "../../../../shared/sessions/task-agent";
import { tryGetMainT } from "../../../i18n";
import { applyRemoteControl, remoteControlCommand } from "../../chat/remote-control";
import type { CliServices } from "../../cli/context";
import { openerOf } from "../../cli/sender";
import type { FsProvider } from "../../fs/bridge/provider";
import type { Attachments } from "../attachments";
import { folderIn } from "../files";
import { type FolderSystem, folderToAdd, SYSTEM_FOLDERS } from "../folders";
import { MAX_MESSAGE_BYTES, RpcFailure } from "../room";
import type { Uploads } from "../uploads";
import { ENVELOPE_BYTES, fitsAsResult, tabOf, unavailable, workspaceOf } from "./common";

let lastWaitReceiptAt = Number.NEGATIVE_INFINITY;

export async function sendChat(
  services: CliServices,
  { workspaceId, tabId, text, attachments: ids = [], when, clientNonce }: RpcParams<"chat.send">,
  attached?: { device: string; attachments: Attachments },
  relay?: RelaySender,
): Promise<RpcResult<"chat.send">> {
  if (!text.trim() && ids.length === 0) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, "a message needs text or an attachment");
  }
  if (ids.length > 0 && !attached) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, "no attachments are kept here");
  }
  const tab = await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  if (relay && tab.type === "claude" && ids.length === 0 && remoteControlCommand(text)) {
    if (when === "after")
      throw new RpcFailure(
        RpcErrorCode.InvalidParams,
        "Remote Control is a setting change; omit --after",
      );
    const target = { workspaceId, tabId };
    return {
      remoteControl: await applyRemoteControl(services, target).catch(chatExecutionFailure),
    };
  }
  const held =
    attached && ids.length > 0
      ? attached.attachments.find(attached.device, workspaceId, tabId, ids)
      : [];
  const images = held.flatMap((h) =>
    h.kind === "image" ? [{ mediaType: h.mediaType, data: h.data }] : [],
  );
  const files = held.flatMap((h) => (h.kind === "file" ? [{ name: h.name, data: h.data }] : []));
  const now = services.clock.now();
  const at = relay?.waits ? Math.max(now, lastWaitReceiptAt + 0.001) : now;
  if (relay?.waits) lastWaitReceiptAt = at;
  const submission =
    !relay && attached && clientNonce
      ? { clientNonce, clientDeviceId: attached.device }
      : undefined;
  const { heldId, itemKey, rejected } = await services
    .ui("chat.send", {
      workspaceId,
      tabId,
      text,
      ...(relay ? { from: relay } : { user: true }),
      ...(images.length > 0 ? { images } : {}),
      ...(files.length > 0 ? { files } : {}),
      ...(when ? { when } : {}),
      ...(attached && (when === "after" || tab.type === "codex")
        ? { device: attached.device }
        : {}),
      ...(submission ? { submission } : {}),
      ...(relay?.waits ? { wait: { receiptAt: at } } : {}),
    })
    .catch((error: unknown) => {
      throw new RpcFailure(
        RpcErrorCode.Unavailable,
        error instanceof Error ? error.message : String(error),
        { outcome: "unknown" },
      );
    });
  if (rejected !== undefined) {
    throw new RpcFailure(RpcErrorCode.Unavailable, rejected, { outcome: "rejected" });
  }
  attached?.attachments.drop(ids);
  return {
    at,
    ...(heldId ? { heldId } : {}),
    ...(itemKey ? { itemKey } : {}),
    ...(submission ? { clientNonce: submission.clientNonce } : {}),
  };
}

export async function unqueueChat(
  services: CliServices,
  { workspaceId, tabId, id }: RpcParams<"chat.unqueue">,
): Promise<RpcResult<"chat.unqueue">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  return services.ui("chat.unqueue", { workspaceId, tabId, id }).catch(chatFailure);
}

export async function editHeldChat(
  services: CliServices,
  { workspaceId, tabId, id, text }: RpcParams<"chat.editHeld">,
  device?: string,
  from?: RelaySender,
): Promise<RpcResult<"chat.editHeld">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  await services
    .ui("chat.editHeld", {
      workspaceId,
      tabId,
      id,
      text,
      ...(device ? { device } : {}),
      ...(from ? { from } : {}),
    })
    .catch(chatFailure);
  return {};
}

export async function withdrawChat(
  services: CliServices,
  { workspaceId, tabId, itemKey }: RpcParams<"chat.withdraw">,
): Promise<RpcResult<"chat.withdraw">> {
  await tabOf(services, workspaceId, tabId, ["claude"]);
  return services.ui("chat.withdraw", { workspaceId, tabId, itemKey }).catch(chatFailure);
}

export async function hurryChat(
  services: CliServices,
  { workspaceId, tabId }: RpcParams<"chat.hurry">,
): Promise<RpcResult<"chat.hurry">> {
  await tabOf(services, workspaceId, tabId, ["claude"]);
  await services.ui("chat.hurry", { workspaceId, tabId }).catch(chatFailure);
  return {};
}

const IMAGE_CHARS = MAX_MESSAGE_BYTES - ENVELOPE_BYTES - 256;

export async function chatImage(
  services: CliServices,
  { workspaceId, tabId, ref, maxEdge, versioned, ifVersion }: RpcParams<"chat.image">,
): Promise<RpcResult<"chat.image">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  const image = await services
    .ui("chat.image", {
      workspaceId,
      tabId,
      ref,
      maxChars: IMAGE_CHARS,
      ...(maxEdge !== undefined ? { maxEdge } : {}),
      ...(versioned ? { versioned } : {}),
      ...(ifVersion !== undefined ? { ifVersion } : {}),
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (/no such image/.test(message)) throw new RpcFailure(RpcErrorCode.NotFound, message);
      return unavailable(error);
    });
  if (!fitsAsResult(image)) {
    throw new RpcFailure(RpcErrorCode.Unavailable, "the image would not go in a frame");
  }
  return image;
}

export async function attachToChat(
  services: CliServices,
  { workspaceId, tabId, mediaType, data }: RpcParams<"chat.attach">,
  device: string,
  attachments: Attachments,
): Promise<RpcResult<"chat.attach">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  return { attachmentId: attachments.take(device, workspaceId, tabId, { mediaType, data }) };
}

export async function beginUpload(
  services: CliServices,
  { workspaceId, tabId, name, size, mediaType }: RpcParams<"chat.upload.begin">,
  device: string,
  uploads: Uploads,
): Promise<RpcResult<"chat.upload.begin">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  return {
    uploadId: uploads.begin(device, workspaceId, tabId, {
      name,
      size,
      ...(mediaType ? { mediaType } : {}),
    }),
  };
}

export async function answerChat(
  services: CliServices,
  {
    workspaceId,
    tabId,
    requestId,
    decision,
    message,
    updatedInput,
    stop,
    always,
    planMode,
    from,
  }: RpcParams<"chat.answer">,
): Promise<RpcResult<"chat.answer">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  await services
    .ui("chat.answer", {
      workspaceId,
      tabId,
      decision,
      expect: requestId,
      ...(from ? { byAgent: true } : {}),
      ...(message !== undefined ? { message } : {}),
      ...(updatedInput ? { updatedInput } : {}),
      ...(stop ? { stop } : {}),
      ...(decision === "allow" && always?.length ? { always } : {}),
      ...(decision === "allow" && planMode ? { planMode } : {}),
    })
    .catch((error: unknown) => {
      if (
        error instanceof Error &&
        error.message === "that request is for the user to answer in the app"
      )
        throw new RpcFailure(RpcErrorCode.Forbidden, error.message);
      return unavailable(error);
    });
  return {};
}

export function settingsOf(choices: CliChatChoices): RpcResult<"chat.settings"> {
  const set = CHAT_MODES[choices.agent];
  const t = tryGetMainT();
  return {
    agent: choices.agent,
    model: choices.model,
    effort: choices.effort,
    permissionMode: choices.mode,
    options: {
      models: choices.models.map((m) => ({ id: m.value, label: m.name })),
      efforts: [...choices.efforts],
      modes: set.modes.map((id) => ({
        id,
        label: t ? String(t(`common:${set.prefix}.${id}`)) : id,
        ...(id === set.dangerous ? { dangerous: true } : {}),
      })),
    },
  };
}

export async function chatSettings(
  services: CliServices,
  { workspaceId, tabId }: RpcParams<"chat.settings">,
): Promise<RpcResult<"chat.settings">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  const choices = await services
    .ui("chat.settings", { workspaceId, tabId, settings: {} })
    .catch(unavailable);
  return settingsOf(choices);
}

export async function configureChat(
  services: CliServices,
  { workspaceId, tabId, model, effort, permissionMode }: RpcParams<"chat.configure">,
  byAgent = false,
  expectedMode?: string,
): Promise<RpcResult<"chat.configure">> {
  const tab = await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  const settings = {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(permissionMode !== undefined ? { mode: permissionMode } : {}),
  };
  if (permissionMode !== undefined) {
    const set = CHAT_MODES[tab.type as ChatAgent];
    if (chatModeNamed(tab.type as ChatAgent, permissionMode) === set.dangerous) {
      const now = await services
        .ui("chat.settings", { workspaceId, tabId, settings: {} })
        .catch(unavailable);
      if (now.dangerousBlocked) {
        throw new RpcFailure(
          RpcErrorCode.Forbidden,
          `${set.dangerous} is turned off on this computer: ${now.dangerousBlocked}`,
        );
      }
    }
  }
  const choices = await services
    .ui(
      "chat.settings",
      { workspaceId, tabId, settings, ...(byAgent ? { expectedMode } : { user: true }) },
      SETTINGS_TIMEOUT_MS,
    )
    .catch(unavailable);
  return settingsOf(choices);
}

const SETTINGS_TIMEOUT_MS = 60_000;

export async function chatCommands(
  services: CliServices,
  { workspaceId, tabId }: RpcParams<"chat.commands">,
): Promise<RpcResult<"chat.commands">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  return services.ui("chat.commands", { workspaceId, tabId }).catch(unavailable);
}

export async function chatFileSuggestions(
  services: CliServices,
  { workspaceId, tabId, query }: RpcParams<"chat.fileSuggestions">,
): Promise<RpcResult<"chat.fileSuggestions">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  const { paths } = await services
    .ui("chat.fileSuggestions", { workspaceId, tabId, query })
    .catch(unavailable);
  return { paths: paths.slice(0, MAX_FILE_SUGGESTIONS) };
}

export async function runChatCommand(
  services: CliServices,
  { workspaceId, tabId, name, args: given, from }: RpcParams<"chat.command">,
  system: FolderSystem = SYSTEM_FOLDERS,
  relay?: RelaySender,
): Promise<RpcResult<"chat.command">> {
  const tab = await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  const bare = name.replace(/^\//, "");
  const lower = bare.toLowerCase();
  if (from && tab.type === "claude" && remoteControlCommand(`/${bare}`)) {
    const target = { workspaceId, tabId };
    return {
      remoteControl: await applyRemoteControl(services, target).catch(chatExecutionFailure),
    };
  }
  const { commands } = await services
    .ui("chat.commands", { workspaceId, tabId })
    .catch(unavailable);
  const command =
    commands.find((c) => c.name.toLowerCase() === lower) ??
    commands.find((c) => c.aliases?.some((alias) => alias.toLowerCase() === lower));
  if (relay && command?.runs === "send") {
    await sendChat(
      services,
      { workspaceId, tabId, text: `/${command.name}${given ? ` ${given}` : ""}` },
      undefined,
      relay,
    );
    return {};
  }
  if (command?.runs !== "command") {
    throw new RpcFailure(
      RpcErrorCode.InvalidParams,
      !command
        ? `/${bare} is not a command this chat lists (chat.commands)`
        : command.runs === "send"
          ? `/${bare} is the agent's own: send it as a message (chat.send)`
          : `/${bare} sets what chat.configure sets`,
    );
  }
  const args =
    command.name === "add-dir" && given?.trim()
      ? await folderToAdd(await addDirPath(services, workspaceId, tabId, given, system), system)
      : given;
  return services
    .ui(
      "chat.command",
      { workspaceId, tabId, name: command.name, ...(args ? { args } : {}) },
      SETTINGS_TIMEOUT_MS,
    )
    .catch(chatExecutionFailure);
}

async function addDirPath(
  services: CliServices,
  workspaceId: string,
  tabId: string,
  given: string,
  system: FolderSystem,
): Promise<string> {
  const p = system.platform === "win32" ? win32 : posix;
  const path = given.trim().replace(/^(["'])(.*)\1$/, "$2");
  if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) {
    return p.join(system.home(), path.slice(1));
  }
  if (p.isAbsolute(path)) return path;
  const info = await services
    .ui("chat.state", { workspaceId, tabId, peek: true })
    .catch(() => null);
  const cwd = info?.cwd ?? workspaceOf(services, workspaceId)?.rootPath ?? system.home();
  return p.resolve(cwd, path);
}

export async function changeChatProfile(
  services: CliServices,
  { workspaceId, tabId, profile, fresh, stop }: RpcParams<"chat.profile">,
): Promise<RpcResult<"chat.profile">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  return services
    .ui(
      "chat.profile",
      { workspaceId, tabId, profile, fresh: fresh ?? false, ...(stop ? { stop } : {}) },
      SETTINGS_TIMEOUT_MS,
    )
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (/ has no profile /.test(message))
        throw new RpcFailure(RpcErrorCode.InvalidParams, message);
      return unavailable(error);
    });
}

export async function interruptChat(
  services: CliServices,
  { workspaceId, tabId }: RpcParams<"chat.interrupt">,
): Promise<RpcResult<"chat.interrupt">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  await services.ui("chat.interrupt", { workspaceId, tabId }).catch(unavailable);
  return {};
}

export async function restartChat(
  services: CliServices,
  { workspaceId, tabId }: RpcParams<"chat.restart">,
): Promise<RpcResult<"chat.restart">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  await services.ui("chat.restart", { workspaceId, tabId }).catch(chatFailure);
  return {};
}

export async function checkChatSignIn(
  services: CliServices,
  { workspaceId, tabId }: RpcParams<"chat.checkSignIn">,
): Promise<RpcResult<"chat.checkSignIn">> {
  await tabOf(services, workspaceId, tabId, ["codex"]);
  return services.ui("chat.checkSignIn", { workspaceId, tabId }).catch(chatFailure);
}

export async function newChat(
  services: CliServices,
  {
    workspaceId,
    agent,
    prompt,
    model,
    effort,
    permissionMode,
    profile,
    folder,
  }: RpcParams<"chat.new">,
  fs?: (workspaceId: string) => Promise<FsProvider>,
  relay?: RelaySender,
): Promise<RpcResult<"chat.new">> {
  const workspace = workspaceOf(services, workspaceId);
  if (!workspace) throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
  const cwd = folder
    ? await folderIn(
        fs ? await fs(workspaceId).catch(unavailable) : null,
        workspace.rootPath,
        folder,
      )
    : workspace.rootPath;
  const settings = {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(permissionMode !== undefined ? { mode: permissionMode } : {}),
  };
  const openedBy = openerOf(relay);
  const opened = await services
    .ui(
      "chat.open",
      {
        workspaceId,
        agent,
        cwd,
        prompt: prompt ?? "",
        placement: { background: true },
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
        ...(profile !== undefined ? { profile } : {}),
        ...(openedBy ? { openedBy } : {}),
        ...(relay ? { from: relay } : { user: true }),
      },
      SETTINGS_TIMEOUT_MS,
    )
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (/ has no profile /.test(message))
        throw new RpcFailure(RpcErrorCode.InvalidParams, message);
      return unavailable(error);
    });
  return { tabId: opened.tabId, ...(opened.error ? { error: opened.error } : {}) };
}

export async function listProfiles(
  services: CliServices,
  { agent, workspaceId }: RpcParams<"profiles.list">,
): Promise<RpcResult<"profiles.list">> {
  if (workspaceId !== undefined && !workspaceOf(services, workspaceId)) {
    throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
  }
  const { profiles } = await services
    .ui("chat.profiles", { ...(agent ? { agent } : {}), ...(workspaceId ? { workspaceId } : {}) })
    .catch(unavailable);
  return {
    profiles: profiles.map(({ id, name, agent, isDefault, workspaceDefault }) => ({
      id,
      name,
      agent,
      isDefault,
      workspaceDefault,
    })),
  };
}

export async function renameChat(
  services: CliServices,
  { workspaceId, tabId, title, from }: RpcParams<"chat.rename">,
): Promise<RpcResult<"chat.rename">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  if (!from && !title.trim())
    throw new RpcFailure(RpcErrorCode.InvalidParams, "a title needs more than spaces");
  return services
    .ui(from ? "tab.rename" : "chat.rename", { workspaceId, tabId, title })
    .catch(unavailable);
}

export async function stopChatRun(
  services: CliServices,
  { workspaceId, tabId, runId }: RpcParams<"chat.stopRun">,
): Promise<RpcResult<"chat.stopRun">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  return { stopped: await services.claudeAgents.stop(workspaceId, tabId, runId) };
}

export async function stopChatTask(
  services: CliServices,
  { workspaceId, tabId, taskId }: RpcParams<"chat.stopTask">,
): Promise<RpcResult<"chat.stopTask">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  await services.ui("chat.stopTask", { workspaceId, tabId, taskId }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/^no task /.test(message)) throw new RpcFailure(RpcErrorCode.NotFound, message);
    return unavailable(error);
  });
  return {};
}

function chatExecutionFailure(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "NexusCode's window did not answer" || message.endsWith(" got no answer")) {
    throw new RpcFailure(RpcErrorCode.Unavailable, `${message} in time`, { outcome: "unknown" });
  }
  return chatFailure(error);
}

export function chatFailure(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/^no (item|tool call|message|held message) /.test(message)) {
    throw new RpcFailure(RpcErrorCode.NotFound, message);
  }
  if (/^a message needs /.test(message)) throw new RpcFailure(RpcErrorCode.InvalidParams, message);
  return unavailable(error);
}

export async function rewindChat(
  services: CliServices,
  { workspaceId, tabId, itemKey, files }: RpcParams<"chat.rewind">,
): Promise<RpcResult<"chat.rewind">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  await services.ui("chat.rewind", { workspaceId, tabId, itemKey, files }).catch(chatFailure);
  return {};
}

export async function forkChat(
  services: CliServices,
  { workspaceId, tabId, itemKey }: RpcParams<"chat.fork">,
  openedBy?: TerminalOpener,
): Promise<RpcResult<"chat.fork">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  return services
    .ui("chat.fork", {
      workspaceId,
      tabId,
      ...(itemKey ? { itemKey } : {}),
      ...(openedBy ? { openedBy } : {}),
    })
    .catch(chatFailure);
}

export async function backgroundChatTool(
  services: CliServices,
  { workspaceId, tabId, toolUseId }: RpcParams<"chat.background">,
): Promise<RpcResult<"chat.background">> {
  await tabOf(services, workspaceId, tabId, ["claude"]);
  await services.ui("chat.background", { workspaceId, tabId, toolUseId }).catch(chatFailure);
  return {};
}

export async function setChatRemoteControl(
  services: CliServices,
  { workspaceId, tabId, enabled }: RpcParams<"chat.remoteControl">,
): Promise<RpcResult<"chat.remoteControl">> {
  await tabOf(services, workspaceId, tabId, ["claude"]);
  return applyRemoteControl(services, { workspaceId, tabId }, enabled).catch(chatExecutionFailure);
}

export async function workChatConfig(
  services: CliServices,
  params: RpcParams<"chat.config">,
): Promise<RpcResult<"chat.config">> {
  await tabOf(services, params.workspaceId, params.tabId, ["claude", "codex"]);
  return services.ui("chat.config", params, SETTINGS_TIMEOUT_MS).catch(chatFailure);
}

export async function workChatMcp(
  services: CliServices,
  params: RpcParams<"chat.mcp">,
): Promise<RpcResult<"chat.mcp">> {
  await tabOf(services, params.workspaceId, params.tabId, ["claude"]);
  return services.ui("chat.mcp", params, SETTINGS_TIMEOUT_MS).catch(chatFailure);
}

export async function resumeChat(
  services: CliServices,
  { workspaceId, agent, sessionId, tabId, from }: RpcParams<"chat.resume">,
  openedBy?: TerminalOpener,
): Promise<RpcResult<"chat.resume">> {
  if (!workspaceOf(services, workspaceId)) {
    throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
  }
  if (tabId) await tabOf(services, workspaceId, tabId, [agent]);
  return services
    .ui("chat.resume", {
      workspaceId,
      agent,
      sessionId,
      ...(tabId ? { tabId } : {}),
      ...(from ? { emptyOnly: true } : {}),
      ...(openedBy ? { openedBy } : {}),
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (/^no conversation /.test(message)) throw new RpcFailure(RpcErrorCode.NotFound, message);
      return unavailable(error);
    });
}

export async function closeChat(
  services: CliServices,
  { workspaceId, tabId }: RpcParams<"chat.close">,
): Promise<RpcResult<"chat.close">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  await services.ui("tab.close", { workspaceId, tabId, force: false }).catch(unavailable);
  return {};
}
