/**
 * A Claude or Codex tab's model, effort and permission mode as the nexus
 * CLI reads and sets them: what the tab runs with and takes, as its
 * composer's chips list them, and what a set asks of it. Pure.
 */

import type { CliChatChoices, CliChatSettings } from "../../../shared/cli/ui";
import { CHAT_MODES, chatModeNamed } from "../../../shared/sessions/chat-modes";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import { type ChatModel, currentModelInfo, type ModelInfo } from "../chat/model";
import { type ModelPickerContext, modelPickerOf } from "../chat/model-picker";

/** What a tab runs with now, and what it may be set to. */
export function chatChoicesOf(
  agent: ChatAgent,
  model: ChatModel,
  context?: ModelPickerContext,
): CliChatChoices {
  const picker = modelPickerOf(agent, model, context);
  return {
    agent,
    model: picker.value ?? null,
    effort: model.effort ?? null,
    mode: model.permissionMode ?? CHAT_MODES[agent].fallback,
    models: picker.options.map(({ model, label }) => ({ value: model.value, name: label })),
    efforts: picker.current?.supportedEffortLevels ?? [],
    ...(model.bypassBlocked ? { dangerousBlocked: model.bypassBlocked } : {}),
  };
}

/** What a set asks the tab to change: those it does not run with already. */
export interface ChatSettingsPlan {
  readonly model?: string;
  readonly effort?: string;
  readonly mode?: string;
}

const listed = (names: readonly string[]) => names.join(", ");

function modelNamed(picker: ReturnType<typeof modelPickerOf>, name: string): ModelInfo | undefined {
  const lower = name.trim().toLowerCase();
  const { models, options } = picker;
  // The full list still accepts aliases the picker folds into a profile model.
  return (
    models.find((m) => m.value.toLowerCase() === lower) ??
    models.find((m) => m.displayName?.toLowerCase() === lower) ??
    models.find((m) => m.resolvedModel?.toLowerCase() === lower) ??
    options.find(
      ({ model, label }) => model.value.toLowerCase() === lower || label.toLowerCase() === lower,
    )?.model
  );
}

/**
 * What setting `wanted` asks of the tab, in the names its program takes.
 * Throws an Error saying what is wrong: a model it does not offer, an
 * effort the model does not take, an unknown mode, or the mode that lets
 * everything run when the request lacks permission to set it.
 */
export function planChatSettings(
  agent: ChatAgent,
  model: ChatModel,
  wanted: CliChatSettings,
  effortSettable: boolean,
  /** Main authorized the dangerous mode, subject to the program's policy. */
  allowDangerousMode = false,
  context?: ModelPickerContext,
): ChatSettingsPlan {
  const picker = modelPickerOf(agent, model, context);
  let nextModel: ModelInfo | undefined;
  if (wanted.model !== undefined) {
    nextModel = modelNamed(picker, wanted.model);
    if (!nextModel) {
      const values = picker.options.map(({ model }) => model.value);
      throw new Error(
        values.length === 0
          ? "it lists no models to pick from"
          : `it offers no model "${wanted.model}"; it offers ${listed(values)}`,
      );
    }
  }
  const modelInfo = nextModel ?? picker.current;
  let effort: string | undefined;
  if (wanted.effort !== undefined) {
    if (!effortSettable) throw new Error("its Claude Code is too old to set the effort");
    const levels = modelInfo?.supportedEffortLevels ?? [];
    const name = modelInfo?.displayName ?? modelInfo?.value ?? "its model";
    if (levels.length === 0) throw new Error(`${name} takes no effort level`);
    effort = levels.find((level) => level.toLowerCase() === wanted.effort?.trim().toLowerCase());
    if (!effort) {
      throw new Error(`${name} takes no effort "${wanted.effort}"; it takes ${listed(levels)}`);
    }
  }
  let mode: string | undefined;
  if (wanted.mode !== undefined) {
    const set = CHAT_MODES[agent];
    mode = chatModeNamed(agent, wanted.mode);
    if (!mode) throw new Error(`no mode "${wanted.mode}"; the modes are ${listed(set.modes)}`);
    if (mode === set.dangerous && !allowDangerousMode) {
      throw new Error(`${mode} lets every tool run unasked; that is the user's to pick in the app`);
    }
    if (mode === set.dangerous && model.bypassBlocked) {
      throw new Error(`${mode} is turned off here: ${model.bypassBlocked}`);
    }
  }
  // A legacy default request may still change which alias is kept across restarts.
  const currentValue =
    nextModel?.value === "default"
      ? (currentModelInfo(picker.models, model.model, model.chosenModel)?.value ?? picker.value)
      : picker.value;
  const newModel = nextModel && nextModel.value !== currentValue ? nextModel.value : undefined;
  return {
    ...(newModel !== undefined ? { model: newModel } : {}),
    // A new model may start at its own effort: set again after it.
    ...(effort !== undefined && (effort !== model.effort || newModel !== undefined)
      ? { effort }
      : {}),
    ...(mode !== undefined && mode !== (model.permissionMode ?? CHAT_MODES[agent].fallback)
      ? { mode }
      : {}),
  };
}
