import i18next from "i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ChatCommand,
  type ChatPanel,
  type ChatSettings,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_BYTES_CHUNK,
} from "../../../../packages/remote-protocol/src";
import type { IpcResult } from "../../../shared/ipc/result";
import { CHAT_MODES } from "../../../shared/sessions/chat-modes";
import type { ComposerController } from "../../components/chat/composer";
import { showToast } from "../../components/ui/toast";
import { ipcCallResult } from "../../ipc/client";
import { copyText } from "../../utils/clipboard";
import {
  type AppCommand,
  copyIndex,
  nthAnswer,
  RESTART_AFTER,
  terminalCommandOf,
} from "../chat/app-commands";
import { CODEX_REMOTE_COMMANDS, parseCodexCommand } from "../chat/codex/commands";
import type { ChatItem, ChatModel, CommandInfo, ImageBlock, ModelInfo } from "../chat/model";
import { type ChatTabState, type CommandCard, emptyTabState, type RevealPart } from "../chat/store";
import type { QueuedMessage } from "../chat/transport/queue";
import { bytesToBase64 } from "../editor/encoding/text-encoding";
import { fitImage } from "./chat-image";
import { hereCommandOf, hereCommandsOf, hereLinkOf, inTerminalLineOf } from "./here-commands";
import { clearPeerDraft } from "./peer-drafts";
import {
  beginPeerSubmission,
  peerSubmissionHasRoom,
  settlePeerSubmission,
} from "./peer-submissions";

export interface PeerChatRef {
  deviceId: string;
  workspaceId: string;
  tabId: string;
}

const CARD_AFTER_MS = 400;

export function answerInCard(message: string, waited: boolean): boolean {
  return waited || message.length > 160 || message.includes("\n");
}

const ATTACH_CHARS = Math.floor(MAX_ATTACHMENT_BYTES / 3) * 4;

async function answerOf<T>(sent: Promise<IpcResult<T>>): Promise<T> {
  const result = await sent;
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

export interface PeerComposerDeps {
  ref: PeerChatRef;
  agent: "claude" | "codex";
  settings: () => ChatSettings | null;
  onSettings: (settings: ChatSettings) => void;
  filesRefused: string;
  onError?: (message: string) => void;
  onRevealed?: (seq: number) => void;
  can?: () => ChatPanel["can"];
  held?: () => ChatPanel["held"];
  folders?: () => PeerFolders | undefined;
  call?: typeof ipcCallResult;
  submissionContext?: () => { selfId?: string; baseline: number; showMain?: () => void };
}

export interface PeerFolders {
  root: string;
  cwd: string;
}

const FOUND_FILES = 50;

export function mentionOf(found: string, { root, cwd }: PeerFolders): string {
  const windows = /^[A-Za-z]:/.test(root) || root.includes("\\");
  const sep = windows ? "\\" : "/";
  const trim = (path: string) => path.replace(/[\\/]+$/, "");
  const base = trim(root);
  const here = trim(cwd);
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (same(here, base)) return found;
  const inside = same(here.slice(0, base.length), base) && /[\\/]/.test(here.charAt(base.length));
  const under = inside ? here.slice(base.length + 1).replace(/\\/g, "/") : null;
  if (under !== null && found.startsWith(`${under}/`)) return found.slice(under.length + 1);
  return `${base}${sep}${windows ? found.replace(/\//g, "\\") : found}`;
}

export function peerComposerController(deps: PeerComposerDeps): ComposerController {
  const { ref, agent, filesRefused } = deps;
  const call = deps.call ?? ipcCallResult;
  const can = () => deps.can?.();
  const upload = async (file: File): Promise<string> => {
    const begun = await call("remote", "peerChatUploadBegin", {
      ...ref,
      name: file.name.slice(-255) || "file",
      size: file.size,
      ...(file.type ? { mediaType: file.type.slice(0, 255) } : {}),
    });
    if (!begun.ok) throw new Error(begun.kind === "unsupported" ? filesRefused : begun.message);
    const { uploadId } = begun.value;
    for (let offset = 0; offset < file.size; offset += MAX_BYTES_CHUNK) {
      const piece = new Uint8Array(
        await file.slice(offset, offset + MAX_BYTES_CHUNK).arrayBuffer(),
      );
      await answerOf(
        call("remote", "peerChatUploadChunk", {
          deviceId: ref.deviceId,
          uploadId,
          offset,
          data: bytesToBase64(piece),
        }),
      );
    }
    const ended = await answerOf(
      call("remote", "peerChatUploadEnd", { deviceId: ref.deviceId, uploadId }),
    );
    return ended.attachmentId;
  };
  let suggests = true;
  const fileSuggestions = async (query: string): Promise<string[]> => {
    if (suggests) {
      const asked = await call("remote", "peerChatFileSuggestions", { ...ref, query });
      if (asked.ok) return asked.value.paths;
      if (asked.kind !== "unsupported") return [];
      suggests = false;
    }
    const folders = deps.folders?.();
    const words = query.trim().slice(0, 256);
    if (!folders || !words) return [];
    const found = await call("remote", "peerFilesFind", {
      deviceId: ref.deviceId,
      workspaceId: ref.workspaceId,
      query: words,
      limit: FOUND_FILES,
    });
    return found.ok ? found.value.files.map((file) => mentionOf(file, folders)) : [];
  };
  const configure = async (change: {
    model?: string;
    effort?: string;
    permissionMode?: string;
  }) => {
    deps.onSettings(await answerOf(call("remote", "peerChatConfigure", { ...ref, ...change })));
  };
  const send = async (
    text: string,
    images: ImageBlock[] = [],
    uploads: readonly string[] = [],
    when?: "now" | "after",
    clientNonce?: string,
    dispatch?: () => void,
  ) => {
    const attachments: string[] = [];
    for (const image of images) {
      const fitted = await fitImage(image, { maxChars: ATTACH_CHARS });
      const { attachmentId } = await answerOf(
        call("remote", "peerChatAttach", {
          ...ref,
          mediaType: fitted.mediaType,
          data: fitted.data,
        }),
      );
      attachments.push(attachmentId);
    }
    attachments.push(...uploads);
    dispatch?.();
    return call("remote", "peerChatSend", {
      ...ref,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(when ? { when } : {}),
      ...(clientNonce ? { clientNonce } : {}),
    });
  };
  const sendChecked = async (
    text: string,
    images?: ImageBlock[],
    uploads?: readonly string[],
    when?: "now" | "after",
  ): Promise<void> => {
    await answerOf(send(text, images, uploads, when));
  };
  const timingOf = (how: "send" | "now" | "queue") =>
    how === "queue" ? "after" : how === "now" && can()?.now ? "now" : undefined;
  const tell = (error: Error) => deps.onError?.(error.message);
  return {
    key: `remote:${ref.deviceId}:${ref.workspaceId}:${ref.tabId}`,
    modes: CHAT_MODES[agent],
    send: (text, images) => sendChecked(text, images),
    sendNow: (text, images) => sendChecked(text, images, [], timingOf("now")),
    ...(agent === "claude"
      ? {
          readHeldNow: async () => {
            if (can()?.hurry) await answerOf(call("remote", "peerChatHurry", ref));
          },
          withdraw: async (itemKey: string) =>
            (await answerOf(call("remote", "peerChatWithdraw", { ...ref, itemKey }))).withdrawn,
        }
      : {}),
    enqueue: (text, images) => {
      void sendChecked(text, images, [], "after").catch(tell);
    },
    removeQueued: (id) => {
      void answerOf(call("remote", "peerChatUnqueue", { ...ref, id })).catch(tell);
      return undefined;
    },
    takeBackQueued: async (id): Promise<QueuedMessage> => {
      const item = deps.held?.()?.find((item) => item.id === id);
      const count = item?.images ?? 0;
      const images = await heldImagesOf(call, ref, id, count);
      if (item?.status && images.length !== count)
        throw new Error("Could not recover all images. The queued message is still on the host.");
      const { text } = await answerOf(call("remote", "peerChatUnqueue", { ...ref, id }));
      return { id, text, images };
    },
    interrupt: () => answerOf(call("remote", "peerChatInterrupt", ref)),
    clearDraft: () => clearPeerDraft(ref),
    attach: async () => {
      throw new Error(filesRefused);
    },
    upload,
    sendUploaded: (how, text, images, uploads) => sendChecked(text, images, uploads, timingOf(how)),
    submitPeer: (how, text, images, files) => {
      if (!peerSubmissionHasRoom(ref)) {
        deps.onError?.(i18next.t("chat.message.peer_limit"));
        return false;
      }
      const context = deps.submissionContext?.();
      const timing = timingOf(how);
      const clientDeviceId = can()?.clientNonce === true ? context?.selfId : undefined;
      const entry = beginPeerSubmission(ref, {
        text,
        images,
        files,
        timing,
        baseline: context?.baseline ?? 0,
        clientDeviceId,
      });
      context?.showMain?.();
      let dispatched = false;
      const fail = (error: string, definite = false) =>
        settlePeerSubmission(ref, entry, {
          status: dispatched && !definite ? "unconfirmed" : "failed",
          error,
        });
      void (async () => {
        const uploads = await Promise.all(files.map(({ file }) => upload(file)));
        const result = await send(
          text,
          images,
          uploads,
          timing,
          clientDeviceId ? entry.nonce : undefined,
          () => {
            dispatched = true;
          },
        );
        if (!result.ok) {
          fail(
            result.message,
            [
              "not-found",
              "permission-denied",
              "unsupported",
              "invalid-args",
              "send-rejected",
            ].includes(result.kind),
          );
          return;
        }
        if (clientDeviceId && result.value.clientNonce !== entry.nonce) {
          fail(i18next.t("chat.message.peer_unconfirmed"));
          return;
        }
        settlePeerSubmission(ref, entry, {
          status: "accepted",
          heldId: result.value.heldId,
          itemKey: result.value.itemKey,
        });
      })().catch((error: Error) => fail(error.message));
      return true;
    },
    maxAttachments: MAX_ATTACHMENTS,
    fileSuggestions,
    supports: (subtype) =>
      subtype === "apply_flag_settings"
        ? (deps.settings()?.options.efforts.length ?? 0) > 0
        : subtype === "file_suggestions" ||
          (subtype === "cancel_async_message" && can()?.withdraw === true),
    setPermissionMode: (permissionMode) => configure({ permissionMode }),
    setModel: (model) => configure({ model }),
    setEffort: (effort) => configure({ effort }),
    revealed: (seq) => deps.onRevealed?.(seq),
  };
}

export function heldQueueOf(held: ChatPanel["held"]): QueuedMessage[] {
  return (held ?? []).map((item) => ({
    id: item.id,
    ...(item.status ? { status: item.status } : {}),
    ...(item.error ? { error: item.error } : {}),
    text: item.truncated ? `${item.text}…` : item.text,
    images: Array.from({ length: item.images ?? 0 }, (_, index) => ({
      mediaType: "",
      data: "",
      remote: { kind: "held" as const, id: item.id, index },
    })),
  }));
}

export async function heldImagesOf(
  call: typeof ipcCallResult,
  ref: PeerChatRef,
  id: string,
  count: number,
): Promise<ImageBlock[]> {
  const read = await Promise.all(
    Array.from({ length: count }, async (_, index): Promise<ImageBlock | null> => {
      const result = await call("remote", "peerChatImage", {
        ...ref,
        ref: { kind: "held", id, index },
      });
      return result.ok ? { mediaType: result.value.mediaType, data: result.value.data } : null;
    }),
  );
  return read.filter((image): image is ImageBlock => image !== null);
}

export function modelsOf(settings: ChatSettings): ModelInfo[] {
  return settings.options.models.map(({ id, label }) => ({
    value: id,
    displayName: label,
    ...(id === settings.model ? { supportedEffortLevels: settings.options.efforts } : {}),
  }));
}

export function withSettings(model: ChatModel, settings: ChatSettings | null): ChatModel {
  if (!settings) return model;
  return {
    ...model,
    init: { commands: [], remoteControl: false, ...model.init, models: modelsOf(settings) },
    ...(settings.model ? { model: settings.model, chosenModel: settings.model } : {}),
    ...(settings.effort ? { effort: settings.effort } : {}),
    permissionMode: settings.permissionMode,
  };
}

export function commandInfosOf(commands: readonly ChatCommand[]): CommandInfo[] {
  return commands.map((c) => ({
    name: c.name,
    description: c.description,
    ...(c.args ? { argumentHint: c.args } : {}),
  }));
}

export function commandOf(
  commands: readonly ChatCommand[],
  text: string,
  agent?: "claude" | "codex",
):
  | { kind: "command"; name: string; args?: string }
  | { kind: "set"; sets: "model" | "effort" | "permissionMode"; value?: string }
  | null {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const [, name, rest] = match;
  const args = rest?.trim() || undefined;
  const typed = name?.toLowerCase();
  const command =
    commands.find((c) => c.name.toLowerCase() === typed) ??
    commands.find((c) => c.aliases?.some((alias) => alias.toLowerCase() === typed));
  if (!command && agent === "codex") {
    const known = parseCodexCommand(text);
    if (known && CODEX_REMOTE_COMMANDS.has(known.name)) {
      return { kind: "command", name: known.name, ...(args ? { args } : {}) };
    }
    if (known?.name === "model" || known?.name === "effort") {
      return { kind: "set", sets: known.name, ...(args ? { value: args } : {}) };
    }
  }
  if (!command || command.runs === "send") return null;
  if (command.runs === "command") {
    return { kind: "command", name: command.name, ...(args ? { args } : {}) };
  }
  if (!command.sets) return null;
  return { kind: "set", sets: command.sets, ...(args ? { value: args } : {}) };
}

const NO_COMMANDS: readonly AppCommand[] = [];

export interface HereCommandDeps {
  items: () => readonly ChatItem[];
  showChanges: () => Pick<CommandCard, "sections"> | undefined;
  status?: () => string;
  openUrl: (url: string) => void;
  terminal?: { run: (line: string) => void; restart?: () => void };
  exit?: () => void;
}

function describe(agent: "claude" | "codex", name: string): string {
  return i18next.t(
    agent === "claude" ? `chat.commands.describe.${name}` : `chat.codex.commands.describe.${name}`,
  );
}

export function helpText(
  agent: "claude" | "codex",
  commands: readonly ChatCommand[],
  hereNames: readonly string[],
): string {
  const lines = [
    ...commands.filter((c) => c.runs === "command").map((c) => [c.name, c.args, c.description]),
    ...hereNames.map((name) => [name, undefined, describe(agent, name)]),
  ].map(([name, args, description]) => `- \`/${name}${args ? ` ${args}` : ""}\` — ${description}`);
  const intro = i18next.t(
    agent === "claude" ? "chat.commands.help_intro" : "chat.codex.commands.help_intro",
  );
  return `${intro}\n\n${lines.join("\n")}`;
}

export interface PeerComposer {
  controller: ComposerController;
  state: ChatTabState;
  commands: CommandInfo[];
  onCommand: (text: string) => boolean;
  card: CommandCard | undefined;
  closeCard: () => void;
}

export function usePeerComposer({
  ref,
  agent,
  model,
  panel,
  active,
  filesRefused,
  onError,
  folders,
  here,
  paneCommands = NO_COMMANDS,
  onOpened,
  submissionContext,
}: {
  ref: PeerChatRef;
  agent: "claude" | "codex";
  model: ChatModel;
  folders?: PeerFolders;
  panel?: ChatPanel | null;
  active: boolean;
  filesRefused: string;
  onError: (message: string) => void;
  here?: HereCommandDeps;
  paneCommands?: readonly AppCommand[];
  onOpened?: (tabId: string, draft?: string) => void;
  submissionContext?: PeerComposerDeps["submissionContext"];
}): PeerComposer {
  const { deviceId, workspaceId, tabId } = ref;
  const [settings, setSettings] = useState<ChatSettings | null>(null);
  const [commands, setCommands] = useState<ChatCommand[]>([]);
  const [reveal, setReveal] = useState<{ part: RevealPart; seq: number } | undefined>();
  const runsWith = `${model.model}|${model.effort}|${model.permissionMode}|${model.process}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again as what it runs with changes
  useEffect(() => {
    if (!active) return;
    let live = true;
    void ipcCallResult("remote", "peerChatSettings", { deviceId, workspaceId, tabId }).then(
      (result) => {
        if (live && result.ok) setSettings(result.value);
      },
    );
    return () => {
      live = false;
    };
  }, [deviceId, workspaceId, tabId, active, runsWith]);

  const codexThread = agent === "codex" ? model.sessionId : undefined;
  const codexProcess = agent === "codex" ? model.process : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a Codex restart or profile move changes its capabilities
  useEffect(() => {
    if (!active) return;
    let live = true;
    void ipcCallResult("remote", "peerChatCommands", { deviceId, workspaceId, tabId }).then(
      (result) => {
        if (live && result.ok) setCommands(result.value.commands);
      },
    );
    return () => {
      live = false;
    };
  }, [deviceId, workspaceId, tabId, active, codexThread, codexProcess]);

  const [held] = useState<{
    settings: ChatSettings | null;
    onError: (message: string) => void;
    can: ChatPanel["can"];
    queued: ChatPanel["held"];
    folders: PeerFolders | undefined;
    here: HereCommandDeps | undefined;
    onOpened: ((tabId: string, draft?: string) => void) | undefined;
    submissionContext: PeerComposerDeps["submissionContext"];
  }>({
    settings: null,
    onError,
    can: undefined,
    queued: undefined,
    folders,
    here,
    onOpened,
    submissionContext,
  });
  held.settings = settings;
  held.onError = onError;
  held.can = panel?.can;
  held.queued = panel?.held;
  held.folders = folders;
  held.here = here;
  held.onOpened = onOpened;
  held.submissionContext = submissionContext;
  const controller = useMemo(
    () =>
      peerComposerController({
        ref: { deviceId, workspaceId, tabId },
        agent,
        settings: () => held.settings,
        onSettings: setSettings,
        filesRefused,
        onError: (message) => held.onError(message),
        onRevealed: (seq) => setReveal((now) => (now?.seq === seq ? undefined : now)),
        can: () => held.can,
        held: () => held.queued,
        folders: () => held.folders,
        submissionContext: () => held.submissionContext?.() ?? { baseline: 0 },
      }),
    [deviceId, workspaceId, tabId, agent, filesRefused, held],
  );

  const [card, setCard] = useState<CommandCard | undefined>();
  const cards = useRef(0);
  const closeCard = useCallback(() => setCard(undefined), []);

  const terminal = Boolean(here?.terminal);
  const hereCommands = useMemo(
    () => hereCommandsOf(agent, commands, terminal),
    [agent, commands, terminal],
  );
  const runHere = useCallback(
    (name: string, args: string, title: string, deps: HereCommandDeps) => {
      const t = i18next.t.bind(i18next);
      const link = hereLinkOf(name);
      if (link) {
        deps.openUrl(link);
        return;
      }
      if (terminalCommandOf(name, args) && deps.terminal) {
        const line = inTerminalLineOf(name, args);
        if (line === null) {
          showToast({ kind: "warning", message: t("agentView.remote.terminalArgument") });
          return;
        }
        deps.terminal.run(line);
        const restart = deps.terminal.restart;
        cards.current += 1;
        const id = `peer-card-${cards.current}`;
        setCard({
          id,
          title,
          text: t("chat.commands.in_terminal", { command: line }),
          ...(RESTART_AFTER.has(name) && restart
            ? {
                sections: [
                  {
                    title: t("chat.commands.restart_after"),
                    empty: "",
                    rows: [
                      {
                        id: "restart",
                        label: t("chat.commands.restart_hint"),
                        actions: [
                          {
                            label: t("chat.commands.restart"),
                            run: () => {
                              setCard((now) => (now?.id === id ? undefined : now));
                              restart();
                            },
                          },
                        ],
                      },
                    ],
                  },
                ],
              }
            : {}),
        });
        return;
      }
      switch (name) {
        case "copy": {
          const n = copyIndex(args);
          const answer = n === null ? null : nthAnswer(deps.items(), n);
          if (answer === null) {
            showToast({ kind: "warning", message: t("chat.commands.copy_none") });
            return;
          }
          copyText(answer);
          showToast({ kind: "info", message: t("chat.commands.copied") });
          return;
        }
        case "diff": {
          const shown = deps.showChanges();
          if (!shown) return;
          cards.current += 1;
          setCard({ id: `peer-card-${cards.current}`, title, ...shown });
          return;
        }
        case "exit":
          deps.exit?.();
          return;
        case "status": {
          if (!deps.status) return;
          cards.current += 1;
          setCard({ id: `peer-card-${cards.current}`, title, text: deps.status() });
          return;
        }
        case "help":
          cards.current += 1;
          setCard({
            id: `peer-card-${cards.current}`,
            title,
            text: helpText(
              agent,
              commands,
              hereCommands.map((c) => c.name),
            ),
          });
          return;
      }
    },
    [agent, commands, hereCommands],
  );

  const onCommand = useCallback(
    (text: string): boolean => {
      const ran = held.here
        ? hereCommandOf(agent, commands, text, Boolean(held.here.terminal))
        : null;
      if (ran && held.here) {
        runHere(ran.name, ran.args, text.trim(), held.here);
        return true;
      }
      const found = commandOf(commands, text, agent);
      if (!found) return false;
      if (found.kind === "command") {
        cards.current += 1;
        const id = `peer-card-${cards.current}`;
        const title = text.trim();
        const fill = (next: CommandCard | undefined) =>
          setCard((now) => (now === undefined || now.id === id ? next : now));
        let waited = false;
        const timer = setTimeout(() => {
          waited = true;
          setCard({ id, title, loading: true });
        }, CARD_AFTER_MS);
        void answerOf(
          ipcCallResult("remote", "peerChatCommand", {
            deviceId,
            workspaceId,
            tabId,
            name: found.name,
            ...(found.args ? { args: found.args } : {}),
          }),
        ).then(
          (said) => {
            clearTimeout(timer);
            if (said.tabId) {
              held.onOpened?.(said.tabId, found.name === "fork" ? found.args : undefined);
            }
            const message = said.message;
            if (message && (said.card ?? answerInCard(message, waited))) {
              fill({ id, title, text: message });
              return;
            }
            if (waited) fill(undefined);
            if (message) showToast({ kind: "info", message });
          },
          (error: Error) => {
            clearTimeout(timer);
            if (waited) fill({ id, title, error: error.message });
            else onError(error.message);
          },
        );
        return true;
      }
      if (found.value === undefined) {
        if (found.sets !== "permissionMode") {
          setReveal((now) => ({ part: found.sets as RevealPart, seq: (now?.seq ?? 0) + 1 }));
        }
        return true;
      }
      void answerOf(
        ipcCallResult("remote", "peerChatConfigure", {
          deviceId,
          workspaceId,
          tabId,
          [found.sets]: found.value,
        }),
      ).then(setSettings, (error: Error) => onError(error.message));
      return true;
    },
    [agent, commands, deviceId, workspaceId, tabId, onError, held, runHere],
  );

  const queue = useMemo(() => heldQueueOf(panel?.held), [panel?.held]);
  const state = useMemo<ChatTabState>(
    () => ({
      ...emptyTabState(),
      phase: "ready",
      model: withSettings(model, settings),
      queue,
      ...(reveal ? { reveal } : {}),
    }),
    [model, settings, reveal, queue],
  );
  const infos = useMemo(
    () => [
      ...commandInfosOf(commands),
      ...(here
        ? hereCommands.map((c) => ({
            name: c.name,
            description: describe(agent, c.name),
            ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
          }))
        : []),
      ...paneCommands
        .filter((c) => !commands.some((listed) => listed.name === c.name))
        .map((c) => ({
          name: c.name,
          description: describe(agent, c.name),
          ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
        })),
    ],
    [agent, commands, hereCommands, here, paneCommands],
  );
  return { controller, state, commands: infos, onCommand, card, closeCard };
}
