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
import { createLogger } from "../../../shared/log/main";
import { type AccountKeyState, deviceLabel } from "../../../shared/remote/account";
import { bugReportOsVersion } from "../../../shared/remote/bug-report";
import type { RoomState } from "../../../shared/remote/room";
import type { SystemStats } from "../../../shared/system/stats";
import type { PhonePushPolicy, RemoteAgentsPolicy } from "../../../shared/types/app-state";
import { broadcast, type CallContext, register, validateArgs } from "../../infra/ipc-router";
import { appErrors } from "../../infra/recent-errors";
import type { CliRemote, CliServices } from "../cli/context";
import type { PeerFileReader } from "../custom-protocols/nexus-workspace";
import type { FsProvider } from "../fs/bridge/provider";
import { SEALED_FILES } from "../keychain/files";
import type { Keychain } from "../keychain/gate";
import { showAppWindow } from "../window/app-windows";
import { RemoteAccount, SavedAccountSchema } from "./account";
import { roomKeyOf } from "./account-key";
import { AccountKeys, KeyError, SavedKeySchema } from "./account-keys";
import { AgentGate } from "./agent-gate";
import { BugReports } from "./bug-reports";
import { ChatWatches } from "./chat-watches";
import { ServerError, SignedOutError, UnreachableError } from "./errors";
import { FileWrites } from "./file-writes";
import { untrackedReader } from "./files";
import type { RemoteRepository } from "./git";
import { installIdAt } from "./install-id";
import type { RemoteNotes } from "./notes";
import { Pairing } from "./pairing";
import { PeerFileReads } from "./peer-file-reads";
import { dropPeerHolds } from "./peer-holds";
import { PEER_READ_METHODS, peerReadCalls } from "./peer-read-calls";
import { PhonePush, type PhonePushActivity } from "./phone-push";
import { RelayConnection } from "./relay-connection";
import { SocketRetryAfter } from "./retry-after";
import { RemoteRoom, RpcFailure } from "./room";
import { returnToProxy } from "./route";
import { SealedFile } from "./sealed-file";
import { servesWith, serveWith } from "./serve";
import { remoteServer, remoteWays } from "./server";
import { snapshotSessions } from "./serving/sessions";
import { SessionWatches } from "./session-watches";
import { TaskGit } from "./task-git";
import { TerminalWatches } from "./terminal-watches";
import { askTicket } from "./ticket";
import { VoiceSessions } from "./voice";
import { listedComputers, VoiceNames } from "./voice-names";

const log = createLogger("remote-index");

const c = ipcContract.remote.call;

function signInOptions(): { loginHint?: string } {
  const loginHint = process.env.NEXUS_REMOTE_LOGIN_HINT?.trim();
  return loginHint ? { loginHint } : {};
}

const MICROPHONE_SETTINGS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  win32: "ms-settings:privacy-microphone",
};

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

async function askPeer<T>(question: () => Promise<T>, chatSend = false): Promise<IpcResult<T>> {
  try {
    return ipcOk(await question());
  } catch (error) {
    if (error instanceof RpcFailure) {
      const data = error.data as { outcome?: unknown } | undefined;
      if (chatSend && data?.outcome === "rejected") return ipcErr("send-rejected", error.message);
      if (chatSend && data?.outcome === "unknown") return ipcErr("send-unconfirmed", error.message);
      if (chatSend && error.code === RpcErrorCode.InvalidParams) {
        return ipcErr("invalid-args", error.message);
      }
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
  keychain: Keychain;
  services: () => CliServices | null;
  allowControl: { get(): boolean; set(allowed: boolean): void };
  allowTerminal: { get(): boolean; set(allowed: boolean): void };
  agents: { get(): RemoteAgentsPolicy; set(policy: RemoteAgentsPolicy): void };
  phonePush: {
    get(): PhonePushPolicy;
    set(policy: PhonePushPolicy): void;
    activity: PhonePushActivity;
  };
  gitStatus?: (workspaceId: string) => Promise<GitStatus | null>;
  fs?: (workspaceId: string) => Promise<FsProvider>;
  repository?: (workspaceId: string) => Promise<RemoteRepository | null>;
  stats?: (workspaceId: string) => Promise<SystemStats | null>;
  theme?: () => string | undefined;
  noteFile?: (workspaceId: string, noteId: string, src: string) => Promise<Uint8Array>;
  notes?: RemoteNotes;
  voiceNames?: () => boolean;
}): Promise<{
  account: RemoteAccount;
  keys: AccountKeys;
  themeChanged(): void;
  wake(): void;
  consentsChanged(): void;
  forgetWorkspace(workspaceId: string): void;
  cli: CliRemote;
  peerFiles: PeerFileReader;
  dispose(): void;
}> {
  const { keychain } = options;
  const box = keychain.box;
  if (!box) throw new Error("there is no keychain to seal the sign-in with");
  const store = new SealedFile(
    join(app.getPath("userData"), SEALED_FILES.remoteAccount),
    box,
    SavedAccountSchema,
  );
  let room: RemoteRoom | null = null;
  let disposed = false;
  let roomFor = "";
  let roomState: RoomState = { status: "off", peers: [] };
  const inRoom = (): RemoteRoom => {
    if (!room) throw new RpcFailure(RpcErrorCode.Unavailable, "not in the room");
    return room;
  };
  const peerFiles = new PeerFileReads((deviceId, params, signal) =>
    inRoom().request(deviceId, PEER_READ_METHODS.peerFilesRead, params, undefined, signal),
  );
  const watches = new ChatWatches({
    services: options.services,
    notify: (to, update) => room?.notify(to, "chat.update", update) ?? Promise.resolve(false),
  });
  const agentGate = new AgentGate({ policy: () => options.agents.get() });
  const { gitStatus } = options;
  const taskGit = gitStatus ? new TaskGit(gitStatus) : null;
  const git = taskGit?.facts;
  const controls = () => ({
    chat: options.allowControl.get(),
    terminal: options.allowTerminal.get(),
  });
  const sessionWatches = new SessionWatches({
    snapshot: async (from) => {
      const services = options.services();
      if (!services) throw new RpcFailure(RpcErrorCode.Unavailable, "the app is still starting");
      const snapshot = await snapshotSessions(services, git, options.notes, "sessions.watch", from);
      return {
        ...snapshot,
        forDevice: () => snapshot.forDevice(controls()),
      };
    },
    notify: (to, update) => room?.notify(to, "sessions.update", update) ?? Promise.resolve(false),
  });
  const terminalWatches = new TerminalWatches({
    services: options.services,
    notify: (to, update) => room?.notify(to, "terminal.update", update) ?? Promise.resolve(false),
  });
  const setRoomState = (state: RoomState) => {
    peerFiles.updateRoom(state);
    if (state.status !== "online") {
      push.presenceLost();
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
  const recentErrors = appErrors;
  const relayFailed = (code: string, status?: number) => recentErrors.record("relay", code, status);
  const server = remoteServer(process.env, app.isPackaged, (message) => log.warn(message));
  const account = new RemoteAccount({
    server,
    ...remoteWays(process.env, app.isPackaged, server),
    store,
    openExternal: (url) => shell.openExternal(url),
    installId: () => installIdAt(join(app.getPath("userData"), "remote-install-id")),
    recordError: recentErrors.record,
    ...signInOptions(),
    onBrowserBack: () => {
      if (process.platform === "darwin") app.focus({ steal: true });
      showAppWindow();
    },
    onChange: (state) => {
      push.accountChanged();
      broadcast("remote", "accountChanged", state);
      void keys?.accountChanged(state).catch(() => {});
      syncRoom();
    },
  });
  const bugReports = new BugReports({
    account,
    errors: recentErrors,
    facts: () => ({
      appVersion: app.getVersion(),
      osVersion: bugReportOsVersion(process.platform, process.getSystemVersion()),
      arch: process.arch,
    }),
  });
  const push = new PhonePush({
    account,
    services: options.services,
    controls,
    policy: options.phonePush.get,
    activity: options.phonePush.activity,
    onEnabledChanged: () => room?.announce(),
  });
  const accountKeys = new AccountKeys({
    account,
    store: new SealedFile(
      join(app.getPath("userData"), SEALED_FILES.remoteKey),
      box,
      SavedKeySchema,
    ),
    onChange: (state) => {
      broadcast("remote", "keyChanged", state);
      syncRoom();
    },
  });
  const socketRetryAfter = new SocketRetryAfter();
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
    retryAfter: socketRetryAfter,
    recordError: recentErrors.record,
    emit: (event) => broadcast("remote", "voiceEvent", event),
  });
  const noteVoice = new VoiceSessions({
    account,
    purpose: "note",
    names,
    retryAfter: socketRetryAfter,
    recordError: recentErrors.record,
    emit: (event) => broadcast("remote", "voiceEvent", event),
  });
  const sessionOf = (id: string) => (noteVoice.has(id) ? noteVoice : voice);

  const relayUrl = async (signal: AbortSignal) => {
    const ticket = await askTicket(account, undefined, signal);
    signal.throwIfAborted();
    const url = account.route.url("/relay", { socket: true });
    url.search = new URLSearchParams({ v: String(RELAY_VERSION), ticket }).toString();
    return url.toString();
  };
  let relay: RelayConnection | null = null;
  const proxyProbe = returnToProxy({
    route: account.route,
    via: () => relay?.onlineRoute() ?? null,
    reconnect: () => relay?.reconnect(),
  });
  function syncRoom(): void {
    if (disposed) return;
    const signedIn = account.state();
    const key = keys?.key() ?? null;
    const want = signedIn.status === "signed-in" && key ? { signedIn, key } : null;
    const id = want
      ? JSON.stringify([want.signedIn.user.id, want.signedIn.device.id, want.key.kid])
      : "";
    if (room && id !== roomFor) {
      room.stop("room-changed");
      room = null;
      relay = null;
      setRoomState({ status: "off", peers: [] });
    }
    if (room || !want) return;
    const { device } = want.signedIn;
    roomFor = id;
    const fileWrites = new FileWrites();
    room = new RemoteRoom({
      self: { id: device.id, name: device.name, platform: device.platform },
      room: { kid: want.key.kid, key: roomKeyOf(want.key.key) },
      app: { name: "NexusCode", version: app.getVersion() },
      ...(options.theme ? { theme: options.theme } : {}),
      serves: () =>
        servesWith(
          options.allowControl.get(),
          options.allowTerminal.get(),
          options.agents.get() !== "deny",
          push.enabled(),
          options.fs !== undefined,
        ),
      connect: (handlers) => {
        relay = new RelayConnection({
          ...handlers,
          url: relayUrl,
          retryAfter: socketRetryAfter,
          unreachable: (url) => void account.route.unreachable(url),
          failed: relayFailed,
        });
        return relay;
      },
      serve: serveWith(options.services, {
        chats: watches,
        sessions: sessionWatches,
        terminals: terminalWatches,
        ...(git ? { git } : {}),
        ...(options.fs ? { files: { fs: options.fs, shrink: shrinkImage } } : {}),
        ...(options.stats ? { stats: options.stats } : {}),
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
        fileWrites,
        deviceName: (id) => room?.state().peers.find((p) => p.id === id)?.name,
        controls,
      }),
      onChange: setRoomState,
      onPresence: (peers) => push.presence(peers),
      onDisconnect: (peer) =>
        dropPeerHolds(
          { chats: watches, sessions: sessionWatches, terminals: terminalWatches, fileWrites },
          peer,
        ),
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
      onForeignKey: () => void keys?.refresh().catch(() => {}),
      onAccountEvent: () => void keys?.refresh().catch(() => {}),
      onPairFrame: (frame) => pairing.onRoomFrame(frame),
      onSignedOut: () => account.recheckSignIn(),
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
    connect: (handlers) =>
      new RelayConnection({
        ...handlers,
        url: relayUrl,
        retryAfter: socketRetryAfter,
        failed: relayFailed,
      }),
    qr: async (text) =>
      `data:image/svg+xml;base64,${Buffer.from(renderSVG(text, { border: 2 })).toString("base64")}`,
    onChange: (state) => broadcast("remote", "pairChanged", state),
  });

  const restored = keychain.whenOpen("remote", async () => {
    await account.restore();
    void account.syncDeviceName();
    keys = accountKeys;
    void accountKeys
      .restore()
      .catch((error: unknown) => log.warn(`the account key was not read: ${String(error)}`));
  });

  register("remote", {
    call: {
      account: async () => ipcOk(account.state()),
      signIn: async (args: unknown) => {
        const provider = validateArgs(c.signIn.args, args)?.provider;
        if (!(await keychain.unlock())) return ipcOk(account.state());
        await restored;
        return ipcOk(await account.signIn(provider));
      },
      serverInfo: () =>
        ask(async () => {
          const info = await account.info();
          push.serverInfo(info);
          return info;
        }),
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
            peerFiles.invalidateDevice(id);
            push.deviceRemoved(id);
          }),
        ).then((result) => (result.ok ? result.value : result));
      },
      room: async () => ipcOk(roomState),
      allowControl: async () => ipcOk(options.allowControl.get()),
      setAllowControl: async (args: unknown) => {
        const { allowed } = validateArgs(c.setAllowControl.args, args);
        options.allowControl.set(allowed);
        push.controlsChanged();
        room?.announce();
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
        push.controlsChanged();
        room?.announce();
        return ipcOk(allowed);
      },
      agentsPolicy: async () => ipcOk(options.agents.get()),
      setAgentsPolicy: async (args: unknown) => {
        const { policy } = validateArgs(c.setAgentsPolicy.args, args);
        options.agents.set(policy);
        room?.announce();
        if (policy === "deny") {
          void options
            .services()
            ?.ui("chat.dropHeld", { agentsOnly: true })
            .catch(() => {});
        }
        return ipcOk(policy);
      },
      bugReportContext: async (args: unknown) => {
        const { locale, includeErrors } = validateArgs(c.bugReportContext.args, args);
        return ipcOk(bugReports.context(locale, includeErrors));
      },
      sendBugReport: async (args: unknown) =>
        ipcOk(await bugReports.send(validateArgs(c.sendBugReport.args, args))),
      phonePushPolicy: async () => ipcOk(options.phonePush.get()),
      setPhonePushPolicy: async (args: unknown) => {
        const { policy } = validateArgs(c.setPhonePushPolicy.args, args);
        options.phonePush.set(policy);
        push.policyChanged();
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
      peerSessionsReorder: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerSessionsReorder.args, args);
        return askPeer(() => inRoom().request(deviceId, "sessions.reorder", params));
      },
      peerSessionsMarkSeen: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerSessionsMarkSeen.args, args);
        return askPeer(() => inRoom().request(deviceId, "sessions.markSeen", params));
      },
      peerSessionEvents: (args: unknown) => {
        const { deviceId, since, limit } = validateArgs(c.peerSessionEvents.args, args);
        return askPeer(() => inRoom().request(deviceId, "events.read", { since, limit }));
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
        if (!room) return ipcErr("send-rejected", "not in the room");
        return askPeer(() => inRoom().request(deviceId, "chat.send", params), true);
      },
      peerChatAnswer: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatAnswer.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.answer", params));
      },
      peerChatRestart: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatRestart.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.restart", params));
      },
      peerChatOriginal: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatOriginal.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.original", params));
      },
      peerChatClose: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatClose.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.close", params));
      },
      peerChatNew: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatNew.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.new", params));
      },
      peerChatRename: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatRename.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.rename", params));
      },
      peerChatCheckSignIn: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatCheckSignIn.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.checkSignIn", params));
      },
      peerChatRuns: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatRuns.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.runs", params));
      },
      peerChatRun: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatRun.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.run", params));
      },
      peerChatRunRead: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatRunRead.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.runRead", params));
      },
      peerChatStopRun: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatStopRun.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.stopRun", params));
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
      ...peerReadCalls(inRoom, askPeer),
      peerFilesRead: (args: unknown, ctx?: CallContext) => {
        const { deviceId, workspaceId, path, as, offset, length, maxBytes } = validateArgs(
          c.peerFilesRead.args,
          args,
        );
        return askPeer(() =>
          peerFiles.read(
            { deviceId, workspaceId },
            path,
            { as, offset, length, maxBytes },
            ctx?.signal,
          ),
        );
      },
      peerFilesReadBytes: (args: unknown, ctx?: CallContext) => {
        const { deviceId, workspaceId, path, offset, length, whole, requireVersion } = validateArgs(
          c.peerFilesReadBytes.args,
          args,
        );
        return askPeer(() =>
          peerFiles.readBytes(
            { deviceId, workspaceId },
            path,
            offset,
            length,
            whole === true && offset === 0,
            requireVersion,
            ctx?.signal,
          ),
        );
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
      peerProfilesUsage: (args: unknown, ctx?: CallContext) => {
        const { deviceId, ...params } = validateArgs(c.peerProfilesUsage.args, args);
        return askPeer(() =>
          inRoom().request(deviceId, "profiles.usage", params, undefined, ctx?.signal),
        );
      },
      peerFoldersList: (args: unknown, ctx?: CallContext) => {
        const { deviceId, ...params } = validateArgs(c.peerFoldersList.args, args);
        return askPeer(() =>
          inRoom().request(deviceId, "folders.list", params, undefined, ctx?.signal),
        );
      },
      peerWorkspaceCreate: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerWorkspaceCreate.args, args);
        return askPeer(() => inRoom().request(deviceId, "workspace.create", params));
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
      peerChatInstructions: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatInstructions.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.instructions", params));
      },
      peerChatInstructionsSet: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerChatInstructionsSet.args, args);
        return askPeer(() => inRoom().request(deviceId, "chat.instructions.set", params));
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
      peerTerminalOpen: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerTerminalOpen.args, args);
        return askPeer(() => inRoom().request(deviceId, "terminal.open", params));
      },
      peerTerminalShells: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerTerminalShells.args, args);
        return askPeer(() => inRoom().request(deviceId, "terminal.shells", params));
      },
      peerTerminalRename: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerTerminalRename.args, args);
        return askPeer(() => inRoom().request(deviceId, "terminal.rename", params));
      },
      peerTerminalClose: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerTerminalClose.args, args);
        return askPeer(() => inRoom().request(deviceId, "terminal.close", params));
      },
      peerTerminalAnswer: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerTerminalAnswer.args, args);
        return askPeer(() => inRoom().request(deviceId, "terminal.answer", params));
      },
      peerConsentAnswer: (args: unknown) => {
        const { deviceId, ...params } = validateArgs(c.peerConsentAnswer.args, args);
        return askPeer(() => inRoom().request(deviceId, "consent.answer", params));
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
    wake: () => relay?.wake(),
    consentsChanged: () => push.consentsChanged(),
    forgetWorkspace: (workspaceId) => taskGit?.forget(workspaceId),
    peerFiles: async (peer, absPath, offset, length, signal) => {
      try {
        return await peerFiles.openBytes(peer, absPath, offset, length, signal);
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
      alias: (deviceId, alias) => account.setDeviceAlias(deviceId, alias),
      request: (deviceId, method, params, timeoutMs, signal) =>
        inRoom().request(deviceId, method, params, timeoutMs, signal),
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      push.dispose();
      proxyProbe.stop();
      pairing.stop();
      account.cancelSignIn();
      voice.cancel();
      noteVoice.cancel();
      room?.stop("shutdown");
    },
  };
}
