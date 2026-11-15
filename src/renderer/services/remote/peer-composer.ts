// What this app's own composer drives for another computer's chat: its
// messages, stop, chips and slash commands go through the room as the
// protocol has them (chat.send, chat.interrupt, chat.configure,
// chat.commands, chat.command), and an image goes ahead with chat.attach.
// What only a chat here has (a queue kept here, a message taken back, a
// file's path) it does without.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type ChatCommand,
  type ChatSettings,
  MAX_ATTACHMENT_BYTES,
} from "../../../../packages/remote-protocol/src";
import type { IpcResult } from "../../../shared/ipc/result";
import { CHAT_MODES } from "../../../shared/sessions/chat-modes";
import type { ComposerController } from "../../components/chat/composer";
import { ipcCallResult } from "../../ipc/client";
import type { ChatModel, CommandInfo, ImageBlock, ModelInfo } from "../chat/model";
import { type ChatTabState, emptyTabState, type RevealPart } from "../chat/store";
import { fitImage } from "./chat-image";

/** The chat, by the device it runs on and its tab there. */
export interface PeerChatRef {
  deviceId: string;
  workspaceId: string;
  tabId: string;
}

/** Room an image's base64 takes in chat.attach. */
const ATTACH_CHARS = Math.floor(MAX_ATTACHMENT_BYTES / 3) * 4;

/** The value of a call, or its failure as an error the composer tells. */
async function answerOf<T>(sent: Promise<IpcResult<T>>): Promise<T> {
  const result = await sent;
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

export interface PeerComposerDeps {
  ref: PeerChatRef;
  agent: "claude" | "codex";
  /** What the chat runs with, as chat.settings or chat.configure last said; null before. */
  settings: () => ChatSettings | null;
  onSettings: (settings: ChatSettings) => void;
  /** What a file the user picked says when it cannot go: only images do. */
  filesRefused: string;
  /** A message sent during a turn that did not go: the box was emptied already. */
  onError?: (message: string) => void;
  /** The chip a bare `/model` or `/effort` asked for has opened. */
  onRevealed?: (seq: number) => void;
  call?: typeof ipcCallResult;
}

/**
 * The composer's controller for another computer's chat. A message sent
 * during a turn waits there for the turn to read it, so nothing is queued
 * here and nothing can be taken back.
 */
export function peerComposerController(deps: PeerComposerDeps): ComposerController {
  const { ref, agent, filesRefused } = deps;
  const call = deps.call ?? ipcCallResult;
  const configure = async (change: {
    model?: string;
    effort?: string;
    permissionMode?: string;
  }) => {
    deps.onSettings(await answerOf(call("remote", "peerChatConfigure", { ...ref, ...change })));
  };
  const send = async (text: string, images: ImageBlock[] = []) => {
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
    await answerOf(
      call("remote", "peerChatSend", {
        ...ref,
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
      }),
    );
  };
  return {
    key: `remote:${ref.deviceId}:${ref.workspaceId}:${ref.tabId}`,
    modes: CHAT_MODES[agent],
    send,
    // The device keeps it till the turn reads it.
    enqueue: (text, images) => {
      void send(text, images).catch((error: Error) => deps.onError?.(error.message));
    },
    removeQueued: () => undefined,
    interrupt: () => answerOf(call("remote", "peerChatInterrupt", ref)),
    clearDraft: () => {},
    attach: async () => {
      throw new Error(filesRefused);
    },
    fileSuggestions: async () => [],
    supports: (subtype) =>
      subtype === "apply_flag_settings" && (deps.settings()?.options.efforts.length ?? 0) > 0,
    setPermissionMode: (permissionMode) => configure({ permissionMode }),
    setModel: (model) => configure({ model }),
    setEffort: (effort) => configure({ effort }),
    revealed: (seq) => deps.onRevealed?.(seq),
  };
}

/** The models the chip offers: the chat's, its own one knowing its effort levels. */
export function modelsOf(settings: ChatSettings): ModelInfo[] {
  return settings.options.models.map(({ id, label }) => ({
    value: id,
    displayName: label,
    ...(id === settings.model ? { supportedEffortLevels: settings.options.efforts } : {}),
  }));
}

/** The chat's model with what its settings say, as the composer reads it. */
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

/** The `/` menu's entries for the chat's commands. */
export function commandInfosOf(commands: readonly ChatCommand[]): CommandInfo[] {
  return commands.map((c) => ({
    name: c.name,
    description: c.description,
    ...(c.args ? { argumentHint: c.args } : {}),
  }));
}

/**
 * What a typed `/name args` does with the chat's commands: an app command
 * runs there, one that sets a chip sets it (or opens its menu, bare), and
 * the agent's own go as a message (null).
 */
export function commandOf(
  commands: readonly ChatCommand[],
  text: string,
):
  | { kind: "command"; name: string; args?: string }
  | { kind: "set"; sets: "model" | "effort" | "permissionMode"; value?: string }
  | null {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const [, name, rest] = match;
  const args = rest?.trim() || undefined;
  const command = commands.find((c) => c.name === name);
  if (!command || command.runs === "send") return null;
  if (command.runs === "command") return { kind: "command", name, ...(args ? { args } : {}) };
  if (!command.sets) return null;
  return { kind: "set", sets: command.sets, ...(args ? { value: args } : {}) };
}

export interface PeerComposer {
  controller: ComposerController;
  state: ChatTabState;
  commands: CommandInfo[];
  onCommand: (text: string) => boolean;
}

/**
 * The composer's controller and state for a chat of another computer's:
 * its settings asked for again whenever what it runs with changes, its
 * commands once.
 */
export function usePeerComposer({
  ref,
  agent,
  model,
  active,
  filesRefused,
  onError,
}: {
  ref: PeerChatRef;
  agent: "claude" | "codex";
  model: ChatModel;
  /** The chat is in front and its device in reach: its settings are asked for. */
  active: boolean;
  filesRefused: string;
  onError: (message: string) => void;
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
  }, [deviceId, workspaceId, tabId, active]);

  // The latest settings and error handler, for a controller made once a chat.
  const [held] = useState<{ settings: ChatSettings | null; onError: (message: string) => void }>({
    settings: null,
    onError,
  });
  held.settings = settings;
  held.onError = onError;
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
      }),
    [deviceId, workspaceId, tabId, agent, filesRefused, held],
  );

  const onCommand = useCallback(
    (text: string): boolean => {
      const found = commandOf(commands, text);
      if (!found) return false;
      if (found.kind === "command") {
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
            if (said.message) onError(said.message);
          },
          (error: Error) => onError(error.message),
        );
        return true;
      }
      if (found.value === undefined) {
        // Bare, it opens its chip's menu, as this app's own /model does.
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
    [commands, deviceId, workspaceId, tabId, onError],
  );

  const state = useMemo<ChatTabState>(
    () => ({
      ...emptyTabState(),
      phase: "ready",
      model: withSettings(model, settings),
      ...(reveal ? { reveal } : {}),
    }),
    [model, settings, reveal],
  );
  const infos = useMemo(() => commandInfosOf(commands), [commands]);
  return { controller, state, commands: infos, onCommand };
}
