// The remote IPC channel: the NexusCode account the remote runs on.

import { join } from "node:path";
import { app, nativeImage, shell, systemPreferences } from "electron";
import {
  RELAY_VERSION,
  RpcErrorCode,
  type RpcNotificationParams,
} from "../../../../packages/remote-protocol/src";
import type { GitStatus } from "../../../shared/git/types";
import { ipcContract } from "../../../shared/ipc/contract";
import { type IpcResult, ipcErr, ipcOk } from "../../../shared/ipc/result";
import type { AccountKeyState } from "../../../shared/remote/account";
import type { RoomState } from "../../../shared/remote/room";
import { broadcast, register, validateArgs } from "../../infra/ipc-router";
import type { CliServices } from "../cli/context";
import type { FsProvider } from "../fs/bridge/provider";
import { RemoteAccount, SavedAccountSchema } from "./account";
import { roomKeyOf } from "./account-key";
import { AccountKeys, KeyError, SavedKeySchema } from "./account-keys";
import { ChatWatches } from "./chat-watches";
import { ServerError, SignedOutError, UnreachableError } from "./errors";
import type { RemoteRepository } from "./git";
import { RelayConnection } from "./relay-connection";
import { RemoteRoom, RpcFailure } from "./room";
import { electronSecretBox, SealedFile } from "./sealed-file";
import { listSessions, servesWith, serveWith } from "./serve";
import { remoteServer } from "./server";
import { SessionWatches } from "./session-watches";
import { TaskGit } from "./task-git";
import { TerminalWatches } from "./terminal-watches";
import { TicketSchema, VoiceSessions } from "./voice";

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
async function keyFlow(flow: () => Promise<AccountKeyState>): Promise<IpcResult<AccountKeyState>> {
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

/** Reads the start of a file git does not track yet, as text, for its diff. */
function untrackedReader(fs: (workspaceId: string) => Promise<FsProvider>) {
  return async (workspaceId: string, absolute: string, maxBytes: number): Promise<string> => {
    const read = await (await fs(workspaceId)).readAbsoluteRange(absolute, 0, maxBytes);
    if (read.kind === "missing") return "";
    return new TextDecoder("utf-8").decode(Buffer.from(read.base64, "base64"), { stream: true });
  };
}

export async function registerRemoteChannel(options: {
  /** The services the nexus CLI uses, once the app made them: the room serves with them. */
  services: () => CliServices | null;
  /** Whether other devices may control this one's chats (off unless the user turned it on), kept with the app's state. */
  allowControl: { get(): boolean; set(allowed: boolean): void };
  /** Whether they may control its terminals too (off unless the user turned it on). */
  allowTerminal: { get(): boolean; set(allowed: boolean): void };
  /** A workspace's git status now, for the tasks' branches the sessions' list tells; null where it is no repository. */
  gitStatus?: (workspaceId: string) => Promise<GitStatus | null>;
  /** A workspace's file system once its agent is ready, for the files other devices read. */
  fs?: (workspaceId: string) => Promise<FsProvider>;
  /** A workspace's repository, for the git other devices read; null where it is none. */
  repository?: (workspaceId: string) => Promise<RemoteRepository | null>;
  /** The app's color theme now, by its id: a phone may follow it. */
  theme?: () => string | undefined;
}): Promise<{
  account: RemoteAccount;
  keys: AccountKeys;
  /** The app's theme changed: the other devices are told. */
  themeChanged(): void;
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
  // The tasks' branches, looked at now and then for the sessions' list.
  const { gitStatus } = options;
  const taskGit = gitStatus ? new TaskGit(gitStatus) : null;
  const git = taskGit?.facts;
  // The sessions' list other devices watch here.
  const sessionWatches = new SessionWatches({
    list: async () => {
      const services = options.services();
      if (!services) throw new RpcFailure(RpcErrorCode.Unavailable, "the app is still starting");
      return listSessions(services, git);
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
  const account = new RemoteAccount({
    server: remoteServer(process.env, app.isPackaged),
    store,
    openExternal: (url) => shell.openExternal(url),
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
  const voice = new VoiceSessions({
    account,
    emit: (event) => broadcast("remote", "voiceEvent", event),
  });

  const relayUrl = async () => {
    const { ticket } = TicketSchema.parse(await account.request("POST", "/relay/ticket"));
    const url = new URL("/relay", account.state().server);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.search = new URLSearchParams({ v: String(RELAY_VERSION), ticket }).toString();
    return url.toString();
  };
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
      serves: () => servesWith(options.allowControl.get(), options.allowTerminal.get()),
      connect: (handlers) => new RelayConnection({ ...handlers, url: relayUrl }),
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
                readUntracked: untrackedReader(options.fs),
              },
            }
          : {}),
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
          broadcast("remote", "peerSessionsUpdate", {
            deviceId: from,
            update: params as RpcNotificationParams<"sessions.update">,
          });
        }
      },
      // Another key version: the account password may have been reset on another device.
      onForeignKey: () => void keys?.refresh().catch(() => {}),
      // The relay says the sign-in ended: the server's 401 then signs the app out.
      onSignedOut: () => void account.request("GET", "/me").catch(() => {}),
    });
    room.start();
  }

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
      deleteAccount: () => ask(() => account.deleteAccount()),
      devices: () => ask(() => account.devices()),
      renameDevice: (args: unknown) => {
        const { id, name } = validateArgs(c.renameDevice.args, args);
        return ask(() => account.renameDevice(id, name));
      },
      removeDevice: (args: unknown) => {
        const { id } = validateArgs(c.removeDevice.args, args);
        return ask(() => account.removeDevice(id));
      },
      room: async () => ipcOk(roomState),
      allowControl: async () => ipcOk(options.allowControl.get()),
      setAllowControl: async (args: unknown) => {
        const { allowed } = validateArgs(c.setAllowControl.args, args);
        options.allowControl.set(allowed);
        // The others learn it from the hello: they show the chats as view only, or not.
        room?.announce();
        return ipcOk(allowed);
      },
      allowTerminal: async () => ipcOk(options.allowTerminal.get()),
      setAllowTerminal: async (args: unknown) => {
        const { allowed } = validateArgs(c.setAllowTerminal.args, args);
        options.allowTerminal.set(allowed);
        room?.announce();
        return ipcOk(allowed);
      },
      peerSessions: (args: unknown) => {
        const { deviceId } = validateArgs(c.peerSessions.args, args);
        return askPeer(() => inRoom().request(deviceId, "sessions.list", {}));
      },
      peerSessionsWatch: (args: unknown) => {
        const { deviceId } = validateArgs(c.peerSessionsWatch.args, args);
        return askPeer(() => inRoom().request(deviceId, "sessions.watch", {}));
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
      peerChatInterrupt: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatInterrupt.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.interrupt", params));
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
      voiceStart: async (args: unknown) => {
        const { language } = validateArgs(c.voiceStart.args, args);
        return ipcOk(await voice.start(language));
      },
      voiceAudio: async (args: unknown) => {
        const { id, audio } = validateArgs(c.voiceAudio.args, args);
        voice.audio(id, audio);
        return ipcOk(undefined);
      },
      voiceStop: async (args: unknown) => {
        voice.stop(validateArgs(c.voiceStop.args, args).id);
        return ipcOk(undefined);
      },
      voiceCancel: async (args: unknown) => {
        voice.cancel(validateArgs(c.voiceCancel.args, args).id);
        return ipcOk(undefined);
      },
      voiceUsage: () => ask(() => voice.usage()),
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
      roomChanged: {},
    },
  });

  return {
    account,
    keys: accountKeys,
    themeChanged: () => room?.announce(),
    dispose: () => {
      account.cancelSignIn();
      voice.cancel();
      room?.stop();
    },
  };
}
