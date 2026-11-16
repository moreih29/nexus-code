// The remote IPC channel: the NexusCode account the remote runs on.

import { join } from "node:path";
import { app, nativeImage, shell, systemPreferences } from "electron";
import { renderSVG } from "uqr";
import {
  RELAY_VERSION,
  RpcErrorCode,
  type RpcNotificationParams,
} from "../../../../packages/remote-protocol/src";
import { MAX_TRANSCRIBE_BYTES } from "../../../../packages/remote-protocol/src/voice";
import type { GitStatus } from "../../../shared/git/types";
import { ipcContract } from "../../../shared/ipc/contract";
import { type IpcResult, ipcErr, ipcOk } from "../../../shared/ipc/result";
import { type AccountKeyState, deviceLabel } from "../../../shared/remote/account";
import type { RoomState } from "../../../shared/remote/room";
import type { RemoteAgentsPolicy } from "../../../shared/types/app-state";
import { broadcast, register, validateArgs } from "../../infra/ipc-router";
import type { CliRemote, CliServices } from "../cli/context";
import type { PeerFileReader } from "../custom-protocols/nexus-workspace";
import type { FsProvider } from "../fs/bridge/provider";
import { RemoteAccount, SavedAccountSchema } from "./account";
import { roomKeyOf } from "./account-key";
import { AccountKeys, KeyError, SavedKeySchema } from "./account-keys";
import { AgentGate } from "./agent-gate";
import { ChatWatches } from "./chat-watches";
import { remoteConsents } from "./consents";
import { ServerError, SignedOutError, UnreachableError } from "./errors";
import { untrackedReader } from "./files";
import type { RemoteRepository } from "./git";
import { installIdAt } from "./install-id";
import type { RemoteNotes } from "./notes";
import { Pairing } from "./pairing";
import { RelayConnection } from "./relay-connection";
import { RemoteRoom, RpcFailure } from "./room";
import { returnToProxy } from "./route";
import { electronSecretBox, SealedFile } from "./sealed-file";
import { listSessions, servesWith, serveWith } from "./serve";
import { remoteProxy, remoteServer } from "./server";
import { SessionWatches } from "./session-watches";
import { TaskGit } from "./task-git";
import { TerminalWatches } from "./terminal-watches";
import { askTicket } from "./ticket";
import { VoiceSessions } from "./voice";
import { listedComputers, VoiceNames } from "./voice-names";

const c = ipcContract.remote.call;

/**
 * For development: NEXUS_REMOTE_LOGIN_HINT signs in as that email, so the
 * dev server's sign-in asks nothing (two instances, one account).
 */
function signInOptions(): { loginHint?: string } {
  const loginHint = process.env.NEXUS_REMOTE_LOGIN_HINT?.trim();
  return loginHint ? { loginHint } : {};
}

/** Asks the server for the renderer: how it failed, where the renderer can act on it. */
/** The system's microphone privacy settings, where it has a page for them. */
const MICROPHONE_SETTINGS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  win32: "ms-settings:privacy-microphone",
};

/**
 * Whether the app may use the microphone. macOS asks the user the first
 * time (the prompt names NSMicrophoneUsageDescription); a fake capture
 * device (Chromium's --use-fake-device-for-media-stream, for testing) needs
 * no asking. Elsewhere the page's getUserMedia finds out.
 */
async function microphoneAccess(): Promise<"granted" | "denied"> {
  if (process.platform !== "darwin") return "granted";
  if (app.commandLine.hasSwitch("use-fake-device-for-media-stream")) return "granted";
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return "granted";
  if (status === "not-determined") {
    return (await systemPreferences.askForMediaAccess("microphone")) ? "granted" : "denied";
  }
  return "denied";
}

async function ask<T>(question: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return ipcOk(await question());
  } catch (error) {
    if (error instanceof SignedOutError) return ipcErr("session-expired", error.message);
    if (error instanceof ServerError && error.status === 404) {
      return ipcErr("not-found", error.message);
    }
    if (error instanceof ServerError || error instanceof UnreachableError) {
      return ipcErr("unavailable", error.message);
    }
    throw error;
  }
}

/**
 * Asks another device of the account for the renderer: its answer, or why
 * not (not-found, forbidden, unsupported: a version without the method,
 * unavailable: not in the room, gone, slow).
 */
async function askPeer<T>(question: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return ipcOk(await question());
  } catch (error) {
    if (error instanceof RpcFailure) {
      const kind =
        error.code === RpcErrorCode.NotFound
          ? "not-found"
          : error.code === RpcErrorCode.Forbidden
            ? "permission-denied"
            : error.code === RpcErrorCode.MethodNotFound
              ? "unsupported"
              : "unavailable";
      return ipcErr(kind, error.message);
    }
    throw error;
  }
}

/** Runs an account password flow for the renderer: its KeyFailure as the kind when it fails. */
async function keyFlow<T = AccountKeyState>(flow: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return ipcOk(await flow());
  } catch (error) {
    if (error instanceof KeyError) {
      return ipcErr(error.failure, error.message, error.retryAt ? { retryAt: error.retryAt } : {});
    }
    throw error;
  }
}

/**
 * An image file drawn as a JPEG small enough that its base64 takes at most
 * `maxChars`: whole first, then smaller; null for one Electron cannot read.
 */
function shrinkImage(
  bytes: Buffer,
  maxChars: number,
): { mediaType: "image/jpeg"; data: string } | null {
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) return null;
  const { width } = image.getSize();
  let scale = 1;
  for (let tries = 0; tries < 6; tries++) {
    const drawn =
      scale === 1
        ? image
        : image.resize({ width: Math.max(1, Math.round(width * scale)), quality: "good" });
    const data = drawn.toJPEG(85).toString("base64");
    if (data.length <= maxChars) return { mediaType: "image/jpeg", data };
    scale *= Math.sqrt(maxChars / data.length) * 0.9;
  }
  return null;
}

export async function registerRemoteChannel(options: {
  /** The services the nexus CLI uses, once the app made them: the room serves with them. */
  services: () => CliServices | null;
  /** Whether other devices may control this one's chats (off unless the user turned it on), kept with the app's state. */
  allowControl: { get(): boolean; set(allowed: boolean): void };
  /** Whether they may control its terminals too (off unless the user turned it on). */
  allowTerminal: { get(): boolean; set(allowed: boolean): void };
  /** Whether agents on the user's other computers may act here: ask (the default), allow or deny. */
  agents: { get(): RemoteAgentsPolicy; set(policy: RemoteAgentsPolicy): void };
  /** A workspace's git status now, for the tasks' branches the sessions' list tells; null where it is no repository. */
  gitStatus?: (workspaceId: string) => Promise<GitStatus | null>;
  /** A workspace's file system once its agent is ready, for the files other devices read. */
  fs?: (workspaceId: string) => Promise<FsProvider>;
  /** A workspace's repository, for the git other devices read; null where it is none. */
  repository?: (workspaceId: string) => Promise<RemoteRepository | null>;
  /** The app's color theme now, by its id: a phone may follow it. */
  theme?: () => string | undefined;
  /** A file of a note's folder (a recording's take), for its second pass; throws if it is not there. */
  noteFile?: (workspaceId: string, noteId: string, src: string) => Promise<Uint8Array>;
  /** The notes other devices list and put photos into, and the note it records into. */
  notes?: RemoteNotes;
  /** Whether voice input sends the account's computer and workspace names along (off unless the user turned it on). */
  voiceNames?: () => boolean;
}): Promise<{
  account: RemoteAccount;
  keys: AccountKeys;
  /** The app's theme changed: the other devices are told. */
  themeChanged(): void;
  /** The user's other computers, for the nexus command's --device. */
  cli: CliRemote;
  /** Reads a file of another computer's workspace, for the previews of quick look over its chats. */
  peerFiles: PeerFileReader;
  dispose(): void;
}> {
  const box = await electronSecretBox();
  const store = new SealedFile(
    join(app.getPath("userData"), "remote-account.bin"),
    box,
    SavedAccountSchema,
  );
  // In the account's room while signed in with the account key; out of it otherwise.
  let room: RemoteRoom | null = null;
  let roomFor = "";
  let roomState: RoomState = { status: "off", peers: [] };
  /** The room, to ask another device through; Unavailable while out of it. */
  const inRoom = (): RemoteRoom => {
    if (!room) throw new RpcFailure(RpcErrorCode.Unavailable, "not in the room");
    return room;
  };
  // The chats other devices watch here, told through the room.
  const watches = new ChatWatches({
    services: options.services,
    notify: (to, update) => room?.notify(to, "chat.update", update) ?? Promise.resolve(false),
  });
  // What agents on the user's other computers may do here, as the user set it.
  const agentGate = new AgentGate({ policy: () => options.agents.get() });
  // The tasks' branches, looked at now and then for the sessions' list.
  const { gitStatus } = options;
  const taskGit = gitStatus ? new TaskGit(gitStatus) : null;
  const git = taskGit?.facts;
  // What the user lets other devices control here, for the consent prompts they may answer.
  const controls = () => ({
    chat: options.allowControl.get(),
    terminal: options.allowTerminal.get(),
  });
  // The sessions' list other devices watch here.
  const sessionWatches = new SessionWatches({
    list: async () => {
      const services = options.services();
      if (!services) throw new RpcFailure(RpcErrorCode.Unavailable, "the app is still starting");
      const list = await listSessions(services, git);
      const recording = options.notes?.recording();
      return recording ? { ...list, recording } : list;
    },
    consents: async (to) => {
      const services = options.services();
      return services ? remoteConsents(services, to, controls()) : [];
    },
    notify: (to, update) => room?.notify(to, "sessions.update", update) ?? Promise.resolve(false),
  });
  // The terminals other devices watch here.
  const terminalWatches = new TerminalWatches({
    services: options.services,
    notify: (to, update) => room?.notify(to, "terminal.update", update) ?? Promise.resolve(false),
  });
  const setRoomState = (state: RoomState) => {
    // A device that left, or this one leaving, ends the watches it had.
    if (state.status !== "online") {
      void watches.dropAll();
      sessionWatches.dropAll();
      void terminalWatches.dropAll();
    } else {
      const here = (id: string) => state.peers.some((p) => p.id === id && p.online);
      for (const id of watches.watchers()) if (!here(id)) void watches.dropDevice(id);
      for (const id of sessionWatches.watchers()) if (!here(id)) sessionWatches.dropDevice(id);
      for (const id of terminalWatches.watchers()) {
        if (!here(id)) void terminalWatches.dropDevice(id);
      }
    }
    roomState = state;
    broadcast("remote", "roomChanged", state);
  };
  let keys: AccountKeys | null = null;
  const server = remoteServer(process.env, app.isPackaged, (m) => console.warn(`[remote] ${m}`));
  const account = new RemoteAccount({
    server,
    proxy: remoteProxy(process.env, app.isPackaged, server),
    store,
    openExternal: (url) => shell.openExternal(url),
    installId: () => installIdAt(join(app.getPath("userData"), "remote-install-id")),
    ...signInOptions(),
    onChange: (state) => {
      broadcast("remote", "accountChanged", state);
      void keys?.accountChanged(state).catch(() => {});
      syncRoom();
    },
  });
  await account.restore();
  const accountKeys = new AccountKeys({
    account,
    store: new SealedFile(join(app.getPath("userData"), "remote-key.bin"), box, SavedKeySchema),
    onChange: (state) => {
      broadcast("remote", "keyChanged", state);
      syncRoom();
    },
  });
  keys = accountKeys;
  // The names of the moment a voice session sends along, when the user turned them on.
  const voiceNames = new VoiceNames({
    enabled: () => options.voiceNames?.() ?? false,
    workspaces: () =>
      options
        .services()
        ?.listWorkspaces()
        .map((w) => w.name) ?? [],
    computers: () => listedComputers(roomState),
    list: (deviceId, timeoutMs) => inRoom().request(deviceId, "sessions.list", {}, timeoutMs),
  });
  const names = () => voiceNames.collect();
  const voice = new VoiceSessions({
    account,
    names,
    emit: (event) => broadcast("remote", "voiceEvent", event),
  });
  // A note's recording: its own session, so a dictation can go on beside it.
  const noteVoice = new VoiceSessions({
    account,
    purpose: "note",
    names,
    emit: (event) => broadcast("remote", "voiceEvent", event),
  });
  const sessionOf = (id: string) => (noteVoice.has(id) ? noteVoice : voice);

  const relayUrl = async () => {
    const ticket = await askTicket(account);
    const url = account.route.url("/relay", { socket: true });
    url.search = new URLSearchParams({ v: String(RELAY_VERSION), ticket }).toString();
    relayVia = url.origin;
    return url.toString();
  };
  /** Where the relay's socket went, and the socket: one that went straight goes back through the proxy. */
  let relayVia: string | null = null;
  let relay: RelayConnection | null = null;
  returnToProxy({
    route: account.route,
    via: () => (roomState.status === "online" ? relayVia : null),
    reconnect: () => relay?.reconnect(),
  });
  function syncRoom(): void {
    const signedIn = account.state();
    const key = keys?.key() ?? null;
    const want = signedIn.status === "signed-in" && key ? { device: signedIn.device, key } : null;
    const id = want ? `${want.device.id}|${want.key.kid}` : "";
    if (room && id !== roomFor) {
      room.stop();
      room = null;
      setRoomState({ status: "off", peers: [] });
    }
    if (room || !want) return;
    roomFor = id;
    room = new RemoteRoom({
      self: { id: want.device.id, name: want.device.name, platform: want.device.platform },
      room: { kid: want.key.kid, key: roomKeyOf(want.key.key) },
      app: { name: "NexusCode", version: app.getVersion() },
      ...(options.theme ? { theme: options.theme } : {}),
      serves: () =>
        servesWith(
          options.allowControl.get(),
          options.allowTerminal.get(),
          options.agents.get() !== "deny",
        ),
      connect: (handlers) => {
        relay = new RelayConnection({
          ...handlers,
          url: relayUrl,
          unreachable: (url) => void account.route.unreachable(url),
        });
        return relay;
      },
      serve: serveWith(options.services, {
        chats: watches,
        sessions: sessionWatches,
        terminals: terminalWatches,
        ...(git ? { git } : {}),
        ...(options.fs ? { files: { fs: options.fs, shrink: shrinkImage } } : {}),
        ...(options.repository && options.fs
          ? {
              repositories: {
                repository: options.repository,
                readUntracked: untrackedReader(
                  options.fs,
                  (id) =>
                    options
                      .services()
                      ?.listWorkspaces()
                      .find((w) => w.id === id)?.rootPath,
                ),
              },
            }
          : {}),
        ...(options.notes ? { notes: options.notes } : {}),
        agents: agentGate,
        deviceName: (id) => room?.state().peers.find((p) => p.id === id)?.name,
        controls,
      }),
      onChange: setRoomState,
      onNotification: (from, method, params) => {
        if (method === "chat.update") {
          broadcast("remote", "peerChatUpdate", {
            deviceId: from,
            update: params as RpcNotificationParams<"chat.update">,
          });
        } else if (method === "terminal.update") {
          broadcast("remote", "peerTerminalUpdate", {
            deviceId: from,
            update: params as RpcNotificationParams<"terminal.update">,
          });
        } else if (method === "sessions.update") {
          voiceNames.took(from, params as RpcNotificationParams<"sessions.update">);
          broadcast("remote", "peerSessionsUpdate", {
            deviceId: from,
            update: params as RpcNotificationParams<"sessions.update">,
          });
        }
      },
      // Another key version: the account password may have been reset on another device.
      onForeignKey: () => void keys?.refresh().catch(() => {}),
      // A rotation or a reset, as the server tells it: ask where the key stands now.
      onAccountEvent: () => void keys?.refresh().catch(() => {}),
      onPairFrame: (frame) => pairing.onRoomFrame(frame),
      // The relay says the sign-in ended: the server's 401 then signs the app out.
      onSignedOut: () => void account.request("GET", "/me").catch(() => {}),
    });
    room.start();
  }

  const pairing = new Pairing({
    self: () => {
      const state = account.state();
      return state.status === "signed-in"
        ? { userId: state.user.id, deviceId: state.device.id }
        : null;
    },
    holdsKey: () => accountKeys.key() !== null,
    key: () => accountKeys.key(),
    adopt: (kid, key) => accountKeys.adopt(kid, key),
    room: () =>
      room && roomState.status === "online"
        ? {
            sendPair: (to, seal) => room?.sendPair(to, seal) ?? Promise.resolve(false),
            deviceName: (id) => roomState.peers.find((p) => p.id === id)?.name,
          }
        : null,
    connect: (handlers) => new RelayConnection({ ...handlers, url: relayUrl }),
    qr: async (text) =>
      `data:image/svg+xml;base64,${Buffer.from(renderSVG(text, { border: 2 })).toString("base64")}`,
    onChange: (state) => broadcast("remote", "pairChanged", state),
  });

  // Asks the server where the key stands; the app does not wait for it.
  void accountKeys.restore();

  register("remote", {
    call: {
      account: async () => ipcOk(account.state()),
      signIn: async (args: unknown) => {
        const provider = validateArgs(c.signIn.args, args)?.provider;
        return ipcOk(await account.signIn(provider));
      },
      serverInfo: () => ask(() => account.info()),
      cancelSignIn: async () => {
        account.cancelSignIn();
        return ipcOk(undefined);
      },
      signOut: async () => {
        await account.signOut();
        return ipcOk(undefined);
      },
      deleteAccount: (args: unknown) => {
        const password = validateArgs(c.deleteAccount.args, args)?.password;
        return keyFlow(() =>
          ask(async () => {
            const headers =
              password !== undefined ? await accountKeys.proofHeaders(password) : null;
            await account.deleteAccount(headers ?? undefined);
          }),
        ).then((result) => (result.ok ? result.value : result));
      },
      devices: () => ask(() => account.devices()),
      setDeviceAlias: (args: unknown) => {
        const { id, alias } = validateArgs(c.setDeviceAlias.args, args);
        return ask(() => account.setDeviceAlias(id, alias));
      },
      removeDevice: (args: unknown) => {
        const { id, password, keepKey } = validateArgs(c.removeDevice.args, args);
        const self = account.state();
        if (self.status === "signed-in" && self.device.id === id) {
          return ask(() => account.removeDevice(id));
        }
        return keyFlow(() =>
          ask(async () => {
            await accountKeys.removeDevices([id], password, { keepKey });
          }),
        ).then((result) => (result.ok ? result.value : result));
      },
      room: async () => ipcOk(roomState),
      allowControl: async () => ipcOk(options.allowControl.get()),
      setAllowControl: async (args: unknown) => {
        const { allowed } = validateArgs(c.setAllowControl.args, args);
        options.allowControl.set(allowed);
        // The others learn it from the hello: they show the chats as view only, or not.
        room?.announce();
        // What they held for after a turn goes no more.
        if (!allowed)
          void options
            .services()
            ?.ui("chat.dropHeld", {})
            .catch(() => {});
        return ipcOk(allowed);
      },
      allowTerminal: async () => ipcOk(options.allowTerminal.get()),
      setAllowTerminal: async (args: unknown) => {
        const { allowed } = validateArgs(c.setAllowTerminal.args, args);
        options.allowTerminal.set(allowed);
        room?.announce();
        return ipcOk(allowed);
      },
      agentsPolicy: async () => ipcOk(options.agents.get()),
      setAgentsPolicy: async (args: unknown) => {
        const { policy } = validateArgs(c.setAgentsPolicy.args, args);
        options.agents.set(policy);
        // Turned off, the others learn it from the hello and send their agents' requests no more.
        room?.announce();
        // Nor does what their agents' messages left held for after a turn.
        if (policy === "deny") {
          void options
            .services()
            ?.ui("chat.dropHeld", { agentsOnly: true })
            .catch(() => {});
        }
        return ipcOk(policy);
      },
      peerSessions: (args: unknown) => {
        const { deviceId } = validateArgs(c.peerSessions.args, args);
        return askPeer(async () => {
          const list = await inRoom().request(deviceId, "sessions.list", {});
          voiceNames.took(deviceId, list);
          return list;
        });
      },
      peerSessionsWatch: (args: unknown) => {
        const { deviceId } = validateArgs(c.peerSessionsWatch.args, args);
        return askPeer(async () => {
          const list = await inRoom().request(deviceId, "sessions.watch", {});
          voiceNames.took(deviceId, list);
          return list;
        });
      },
      peerSessionsUnwatch: (args: unknown) => {
        const { deviceId, watchId } = validateArgs(c.peerSessionsUnwatch.args, args);
        return askPeer(() => inRoom().request(deviceId, "sessions.unwatch", { watchId }));
      },
      chatChanged: async (args: unknown) => {
        const { watchId, change } = validateArgs(c.chatChanged.args, args);
        await watches.changed(watchId, change);
        return ipcOk(undefined);
      },
      chatWatchEnded: async (args: unknown) => {
        watches.ended(validateArgs(c.chatWatchEnded.args, args).watchId);
        return ipcOk(undefined);
      },
      terminalChanged: async (args: unknown) => {
        const { watchId, change } = validateArgs(c.terminalChanged.args, args);
        await terminalWatches.changed(watchId, change);
        return ipcOk(undefined);
      },
      terminalWatchEnded: async (args: unknown) => {
        terminalWatches.ended(validateArgs(c.terminalWatchEnded.args, args).watchId);
        return ipcOk(undefined);
      },
      peerChatWatch: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatWatch.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.watch", params));
      },
      peerChatUnwatch: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatUnwatch.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.unwatch", params));
      },
      peerChat: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChat.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.read", params));
      },
      peerChatSend: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatSend.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.send", params));
      },
      peerChatAnswer: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatAnswer.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.answer", params));
      },
      peerChatRestart: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatRestart.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.restart", params));
      },
      peerChatInterrupt: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatInterrupt.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.interrupt", params));
      },
      peerChatSettings: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatSettings.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.settings", params));
      },
      peerChatConfigure: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatConfigure.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.configure", params));
      },
      peerChatCommands: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatCommands.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.commands", params));
      },
      peerChatUploadBegin: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatUploadBegin.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.upload.begin", params));
      },
      peerChatUploadChunk: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatUploadChunk.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.upload.chunk", params));
      },
      peerChatUploadEnd: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatUploadEnd.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.upload.end", params));
      },
      peerChatFileSuggestions: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatFileSuggestions.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.fileSuggestions", params));
      },
      peerChatCommand: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatCommand.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.command", params));
      },
      peerChatStopTask: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatStopTask.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.stopTask", params));
      },
      peerChatImage: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatImage.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.image", params));
      },
      peerFilesList: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerFilesList.args, args);
        return askPeer(() => inRoom().request(deviceId, "files.list", params));
      },
      peerFilesFind: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerFilesFind.args, args);
        return askPeer(() => inRoom().request(deviceId, "files.find", params));
      },
      peerFilesRead: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerFilesRead.args, args);
        return askPeer(() => inRoom().request(deviceId, "files.read", params));
      },
      peerGitDiff: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerGitDiff.args, args);
        return askPeer(() => inRoom().request(deviceId, "git.diff", params));
      },
      peerHistory: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerHistory.args, args);
        return askPeer(() => inRoom().request(deviceId, "history.list", params));
      },
      peerChatResume: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatResume.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.resume", params));
      },
      peerChatRewindPreview: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatRewindPreview.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.rewindPreview", params));
      },
      peerChatRewind: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatRewind.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.rewind", params));
      },
      peerChatFork: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatFork.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.fork", params));
      },
      peerChatUnqueue: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatUnqueue.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.unqueue", params));
      },
      peerChatWithdraw: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatWithdraw.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.withdraw", params));
      },
      peerChatHurry: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatHurry.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.hurry", params));
      },
      peerChatBackground: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatBackground.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.background", params));
      },
      peerChatRemoteControl: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatRemoteControl.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.remoteControl", params));
      },
      peerProfiles: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerProfiles.args, args);
        return askPeer(() => inRoom().request(deviceId, "profiles.list", params));
      },
      peerChatConfig: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatConfig.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.config", params));
      },
      peerChatMcp: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatMcp.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.mcp", params));
      },
      peerChatProfile: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatProfile.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.profile", params));
      },
      peerChatAttach: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatAttach.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.attach", params));
      },
      peerTerminal: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerTerminal.args, args);
        return askPeer(() => inRoom().request(deviceId, "terminal.read", params));
      },
      peerTerminalWatch: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerTerminalWatch.args, args);
        return askPeer(() => inRoom().request(deviceId, "terminal.watch", params));
      },
      peerTerminalUnwatch: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerTerminalUnwatch.args, args);
        return askPeer(() => inRoom().request(deviceId, "terminal.unwatch", params));
      },
      peerTerminalInput: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerTerminalInput.args, args);
        return askPeer(() => inRoom().request(deviceId, "terminal.input", params));
      },
      key: async () => ipcOk(accountKeys.state()),
      refreshKey: () => keyFlow(() => accountKeys.refresh()),
      createKey: (args: unknown) => {
        const { password } = validateArgs(c.createKey.args, args);
        return keyFlow(() => accountKeys.create(password));
      },
      unlockKey: (args: unknown) => {
        const { password } = validateArgs(c.unlockKey.args, args);
        return keyFlow(() => accountKeys.unlock(password));
      },
      changePassword: (args: unknown) => {
        const { current, next } = validateArgs(c.changePassword.args, args);
        return keyFlow(() => accountKeys.changePassword(current, next));
      },
      resetKey: (args: unknown) => {
        const { password } = validateArgs(c.resetKey.args, args);
        return keyFlow(() => accountKeys.reset(password));
      },
      cancelReset: (args: unknown) => {
        const { password } = validateArgs(c.cancelReset.args, args);
        return keyFlow(() => accountKeys.cancelReset(password));
      },
      pairing: async () => ipcOk(pairing.current()),
      pairStart: async () => ipcOk(await pairing.start()),
      pairStop: async () => ipcOk(pairing.stop()),
      pairAnswer: async (args: unknown) => {
        const { allow } = validateArgs(c.pairAnswer.args, args);
        return ipcOk(await pairing.answer(allow));
      },
      voiceStart: async (args: unknown) => {
        const { language, purpose } = validateArgs(c.voiceStart.args, args);
        return ipcOk(await (purpose === "note" ? noteVoice : voice).start(language));
      },
      voiceAudio: async (args: unknown) => {
        const { id, audio } = validateArgs(c.voiceAudio.args, args);
        sessionOf(id).audio(id, audio);
        return ipcOk(undefined);
      },
      voiceStop: async (args: unknown) => {
        const { id } = validateArgs(c.voiceStop.args, args);
        sessionOf(id).stop(id);
        return ipcOk(undefined);
      },
      voiceCancel: async (args: unknown) => {
        const { id } = validateArgs(c.voiceCancel.args, args);
        sessionOf(id).cancel(id);
        return ipcOk(undefined);
      },
      voiceUsage: () => ask(() => voice.usage()),
      voiceTerms: () => ask(() => voice.terms()),
      setVoiceTerms: (args: unknown) => {
        const { terms } = validateArgs(c.setVoiceTerms.args, args);
        return ask(() => voice.setTerms(terms));
      },
      voiceTranscribe: async (args: unknown) => {
        const { workspaceId, noteId, file, token, language } = validateArgs(
          c.voiceTranscribe.args,
          args,
        );
        let bytes: Uint8Array;
        try {
          if (!options.noteFile) throw new Error("no notes");
          bytes = await options.noteFile(workspaceId, noteId, file);
        } catch (error) {
          return ipcOk({
            status: "failed" as const,
            reason: "missing" as const,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        if (bytes.byteLength > MAX_TRANSCRIBE_BYTES) {
          return ipcOk({
            status: "failed" as const,
            reason: "too-big" as const,
            message: `${bytes.byteLength} bytes`,
          });
        }
        const type = file.endsWith(".ogg") ? "audio/ogg" : "audio/webm";
        return ipcOk(await noteVoice.transcribe(bytes, type, token, language));
      },
      voiceTranscription: (args: unknown) => {
        const { id } = validateArgs(c.voiceTranscription.args, args);
        return ask(() => noteVoice.transcription(id));
      },
      voiceTranscriptionDrop: (args: unknown) => {
        const { id } = validateArgs(c.voiceTranscriptionDrop.args, args);
        return ask(() => noteVoice.dropTranscription(id));
      },
      voiceMicrophone: async () => ipcOk(await microphoneAccess()),
      openMicrophoneSettings: async () => {
        const url = MICROPHONE_SETTINGS[process.platform];
        if (url) await shell.openExternal(url);
        return ipcOk(undefined);
      },
    },
    listen: {
      accountChanged: {},
      keyChanged: {},
      pairChanged: {},
      roomChanged: {},
    },
  });

  return {
    account,
    keys: accountKeys,
    themeChanged: () => room?.announce(),
    peerFiles: async (peer, absPath, offset, length) => {
      try {
        const read = await inRoom().request(peer.deviceId, "files.read", {
          workspaceId: peer.workspaceId,
          path: absPath,
          as: "bytes",
          offset,
          length,
        });
        if (read.kind !== "bytes") throw new Error("not read as bytes");
        return { base64: read.data, size: read.size };
      } catch (error) {
        if (error instanceof RpcFailure && error.code === RpcErrorCode.NotFound) return "missing";
        throw error;
      }
    },
    cli: {
      inRoom: () => room !== null && roomState.status === "online",
      devices: async () => {
        const peers = roomState.peers;
        const self = account.state();
        const selfId = self.status === "signed-in" ? self.device.id : "";
        const listed = await account.devices().catch(() => null);
        const known: {
          id: string;
          name: string;
          alias?: string | null;
          platform: string;
          lastSeenAt?: number;
        }[] = listed ?? [
          ...(self.status === "signed-in" ? [self.device] : []),
          ...peers.map((p) => ({
            id: p.id,
            name: p.hostName ?? p.name,
            alias: p.hostName ? p.name : null,
            platform: p.platform,
          })),
        ];
        return known.map((d) => {
          const peer = peers.find((p) => p.id === d.id);
          const isSelf = d.id === selfId;
          const hostName = peer ? peer.hostName : d.alias ? d.name : undefined;
          return {
            id: d.id,
            name: peer?.name ?? deviceLabel(d),
            ...(hostName ? { hostName } : {}),
            platform: d.platform,
            self: isSelf,
            online: isSelf ? roomState.status === "online" : (peer?.online ?? false),
            ...(d.lastSeenAt !== undefined ? { lastSeen: d.lastSeenAt } : {}),
            serves: peer?.serves ?? [],
            ...(peer?.schema ? { schema: peer.schema } : {}),
          };
        });
      },
      request: (deviceId, method, params, timeoutMs) =>
        inRoom().request(deviceId, method, params, timeoutMs),
    },
    dispose: () => {
      account.cancelSignIn();
      voice.cancel();
      noteVoice.cancel();
      room?.stop();
    },
  };
}
