import { posix, win32 } from "node:path";
import {
  MAX_FILE_SUGGESTIONS,
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
} from "../../../../../packages/remote-protocol/src";
import type { RelaySender } from "../../../../shared/chat/relay";
import type { CliChatChoices } from "../../../../shared/cli/ui";
import { CHAT_MODES, chatModeNamed } from "../../../../shared/sessions/chat-modes";
import type { ChatAgent } from "../../../../shared/sessions/task-agent";
import { tryGetMainT } from "../../../i18n";
import { applyRemoteControl, remoteControlCommand } from "../../chat/remote-control";
import type { CliServices } from "../../cli/context";
import type { FsProvider } from "../../fs/bridge/provider";
import type { Attachments } from "../attachments";
import { folderIn } from "../files";
import { type FolderSystem, folderToAdd, SYSTEM_FOLDERS } from "../folders";
import { MAX_MESSAGE_BYTES, RpcFailure } from "../room";
import type { Uploads } from "../uploads";
import { ENVELOPE_BYTES, fitsAsResult, tabOf, unavailable, workspaceOf } from "./common";

/*
 * The chat's controls, as its composer, request card, stop button and tab
 * do: the device asking is the user's own, holding the account key, so
 * what it sends is the user's, not an agent's.
 */

let lastWaitReceiptAt = Number.NEGATIVE_INFINITY;

/**
 * Sends the chat a message, with the images and files the device attached
 * for it (chat.attach, chat.upload), which then go; text or an attachment
 * at least.
 */
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
  // The agent's chat.send was authorized by the receiving device's AgentGate.
  if (relay && tab.type === "claude" && ids.length === 0 && remoteControlCommand(text)) {
    if (when === "after")
      throw new RpcFailure(
        RpcErrorCode.InvalidParams,
        "Remote Control is a setting change; omit --after",
      );
    const target = { workspaceId, tabId };
    return { remoteControl: await applyRemoteControl(services, target).catch(chatFailure) };
  }
  const held =
    attached && ids.length > 0
      ? attached.attachments.find(attached.device, workspaceId, tabId, ids)
      : [];
  const images = held.flatMap((h) =>
    h.kind === "image" ? [{ mediaType: h.mediaType, data: h.data }] : [],
  );
  const files = held.flatMap((h) => (h.kind === "file" ? [{ name: h.name, data: h.data }] : []));
  // Before it goes: what the chat shows from here on is from this message on.
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
      // An agent's shows as its, and waits while the chat asks the user something.
      ...(relay ? { from: relay } : { user: true }),
      ...(images.length > 0 ? { images } : {}),
      ...(files.length > 0 ? { files } : {}),
      ...(when ? { when } : {}),
      // Held, it is dropped if control from other computers is turned off first.
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

/** Takes back a message a chat holds for after its turn, with its whole text. */
export async function unqueueChat(
  services: CliServices,
  { workspaceId, tabId, id }: RpcParams<"chat.unqueue">,
): Promise<RpcResult<"chat.unqueue">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  return services.ui("chat.unqueue", { workspaceId, tabId, id }).catch(chatFailure);
}

/** Changes the text of a message a chat holds for after its turn. */
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

/** Takes back one of the user's messages a Claude chat has not read. */
export async function withdrawChat(
  services: CliServices,
  { workspaceId, tabId, itemKey }: RpcParams<"chat.withdraw">,
): Promise<RpcResult<"chat.withdraw">> {
  await tabOf(services, workspaceId, tabId, ["claude"]);
  return services.ui("chat.withdraw", { workspaceId, tabId, itemKey }).catch(chatFailure);
}

/** Has a Claude chat read its unread messages now. */
export async function hurryChat(
  services: CliServices,
  { workspaceId, tabId }: RpcParams<"chat.hurry">,
): Promise<RpcResult<"chat.hurry">> {
  await tabOf(services, workspaceId, tabId, ["claude"]);
  await services.ui("chat.hurry", { workspaceId, tabId }).catch(chatFailure);
  return {};
}

/** Room an image's base64 may take in its answer: the frame, less the envelope and its other fields. */
const IMAGE_CHARS = MAX_MESSAGE_BYTES - ENVELOPE_BYTES - 256;

/** An image of the chat, drawn smaller where it would not go in a frame. */
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

/** Keeps an image for the device's next message to the chat. */
export async function attachToChat(
  services: CliServices,
  { workspaceId, tabId, mediaType, data }: RpcParams<"chat.attach">,
  device: string,
  attachments: Attachments,
): Promise<RpcResult<"chat.attach">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  return { attachmentId: attachments.take(device, workspaceId, tabId, { mediaType, data }) };
}

/** Starts a file's upload for the device's next message to the chat. */
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
    .catch(unavailable);
  return {};
}

/** What a tab's choices are, as the protocol tells them; the modes named in this app's language. */
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

/**
 * Sets what the user asked from another device, as the composer's chips
 * do: the mode that lets everything run too, unless a policy keeps it off
 * here (Forbidden, with why).
 */
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
      // An agent never takes the mode that lets everything run.
      { workspaceId, tabId, settings, ...(byAgent ? { expectedMode } : { user: true }) },
      SETTINGS_TIMEOUT_MS,
    )
    .catch(unavailable);
  return settingsOf(choices);
}

/** How long a change of settings may take: a model change restarts nothing, but waits to be shown. */
const SETTINGS_TIMEOUT_MS = 60_000;

export async function chatCommands(
  services: CliServices,
  { workspaceId, tabId }: RpcParams<"chat.commands">,
): Promise<RpcResult<"chat.commands">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  return services.ui("chat.commands", { workspaceId, tabId }).catch(unavailable);
}

/** What an @ in the tab's composer may name, as its agent suggests it. */
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

/**
 * Runs one of the app's commands the tab lists, as its composer runs it
 * typed; one the agent runs goes with chat.send, and the model and effort
 * with chat.configure.
 */
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
    return { remoteControl: await applyRemoteControl(services, target).catch(chatFailure) };
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
  // A folder the chat may read, which the files methods then read too: by its
  // real path, and not one that would open all of the disk.
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
    .catch(unavailable);
}

/** The folder /add-dir names, as the composer reads it: from the chat's folder, or the home's. */
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

/**
 * Has a chat run with another profile, as the CLI's chat profile does, the
 * user asking from another device: no one here is asked again.
 */
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

/** Starts a chat's program again, as its banner does: the user's, from another device. */
export async function restartChat(
  services: CliServices,
  { workspaceId, tabId }: RpcParams<"chat.restart">,
): Promise<RpcResult<"chat.restart">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  await services.ui("chat.restart", { workspaceId, tabId }).catch(chatFailure);
  return {};
}

/** Asks a Codex chat's program again whether it is signed in, as its banner does: the user's. */
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
  const opened = await services
    .ui(
      "chat.open",
      {
        workspaceId,
        agent,
        cwd,
        prompt: prompt ?? "",
        // Behind what the window shows: whoever sits at this computer keeps their place.
        placement: { background: true },
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
        ...(profile !== undefined ? { profile } : {}),
        // An agent's prompt shows as its; its settings never the mode that lets everything run.
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

/** The agent profiles a new chat may run with. */
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

/** Renames the chat, as its tab's rename does. */
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

/** Stops one of the chat's runs, as its pane's stop button does. */
export async function stopChatRun(
  services: CliServices,
  { workspaceId, tabId, runId }: RpcParams<"chat.stopRun">,
): Promise<RpcResult<"chat.stopRun">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  return { stopped: await services.claudeAgents.stop(workspaceId, tabId, runId) };
}

/** Stops one of the chat's tasks, as its panel's stop button does. */
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

/** A tab's failure as another device is told it: an item or a call it does not have is not found. */
export function chatFailure(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/^no (item|tool call|message|held message) /.test(message)) {
    throw new RpcFailure(RpcErrorCode.NotFound, message);
  }
  if (/^a message needs /.test(message)) throw new RpcFailure(RpcErrorCode.InvalidParams, message);
  return unavailable(error);
}

/** Rewinds a chat to before one of the user's messages. */
export async function rewindChat(
  services: CliServices,
  { workspaceId, tabId, itemKey, files }: RpcParams<"chat.rewind">,
): Promise<RpcResult<"chat.rewind">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  await services.ui("chat.rewind", { workspaceId, tabId, itemKey, files }).catch(chatFailure);
  return {};
}

/** Forks a chat into a new tab in the background. */
export async function forkChat(
  services: CliServices,
  { workspaceId, tabId, itemKey }: RpcParams<"chat.fork">,
): Promise<RpcResult<"chat.fork">> {
  await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
  return services
    .ui("chat.fork", { workspaceId, tabId, ...(itemKey ? { itemKey } : {}) })
    .catch(chatFailure);
}

/** Sends a Claude chat's running command or subagent to the background. */
export async function backgroundChatTool(
  services: CliServices,
  { workspaceId, tabId, toolUseId }: RpcParams<"chat.background">,
): Promise<RpcResult<"chat.background">> {
  await tabOf(services, workspaceId, tabId, ["claude"]);
  await services.ui("chat.background", { workspaceId, tabId, toolUseId }).catch(chatFailure);
  return {};
}

/** Turns a Claude chat's Remote Control on or off. */
export async function setChatRemoteControl(
  services: CliServices,
  { workspaceId, tabId, enabled }: RpcParams<"chat.remoteControl">,
): Promise<RpcResult<"chat.remoteControl">> {
  await tabOf(services, workspaceId, tabId, ["claude"]);
  return applyRemoteControl(services, { workspaceId, tabId }, enabled).catch(chatFailure);
}

/**
 * A Claude chat's Claude Code settings, or a Codex chat's defaults, read or
 * changed as its dialog does: the user's, from another device.
 */
export async function workChatConfig(
  services: CliServices,
  params: RpcParams<"chat.config">,
): Promise<RpcResult<"chat.config">> {
  await tabOf(services, params.workspaceId, params.tabId, ["claude", "codex"]);
  return services.ui("chat.config", params, SETTINGS_TIMEOUT_MS).catch(chatFailure);
}

/** Works a Claude chat's MCP server, as its panel does: the user's, from another device. */
export async function workChatMcp(
  services: CliServices,
  params: RpcParams<"chat.mcp">,
): Promise<RpcResult<"chat.mcp">> {
  await tabOf(services, params.workspaceId, params.tabId, ["claude"]);
  return services.ui("chat.mcp", params, SETTINGS_TIMEOUT_MS).catch(chatFailure);
}

/** Goes on with a conversation of the past in a new chat, behind what this computer shows. */
export async function resumeChat(
  services: CliServices,
  { workspaceId, agent, sessionId, tabId, from }: RpcParams<"chat.resume">,
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
