import type { CliChatChoices, CliChatSettings } from "../../../shared/cli/ui";
import { CHAT_MODES, chatModeNamed } from "../../../shared/sessions/chat-modes";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import { type ChatModel, currentModelInfo, type ModelInfo } from "../chat/model";
import { type ModelPickerContext, modelPickerOf } from "../chat/model-picker";

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

export interface ChatSettingsPlan {
  readonly model?: string;
  readonly effort?: string;
  readonly mode?: string;
}

const listed = (names: readonly string[]) => names.join(", ");

function modelNamed(picker: ReturnType<typeof modelPickerOf>, name: string): ModelInfo | undefined {
  const lower = name.trim().toLowerCase();
  const { models, options } = picker;
  return (
    models.find((m) => m.value.toLowerCase() === lower) ??
    models.find((m) => m.displayName?.toLowerCase() === lower) ??
    models.find((m) => m.resolvedModel?.toLowerCase() === lower) ??
    options.find(
      ({ model, label }) => model.value.toLowerCase() === lower || label.toLowerCase() === lower,
    )?.model
  );
}

export function planChatSettings(
  agent: ChatAgent,
  model: ChatModel,
  wanted: CliChatSettings,
  effortSettable: boolean,
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
  const currentValue =
    nextModel?.value === "default"
      ? (currentModelInfo(picker.models, model.model, model.chosenModel)?.value ?? picker.value)
      : picker.value;
  const newModel = nextModel && nextModel.value !== currentValue ? nextModel.value : undefined;
  return {
    ...(newModel !== undefined ? { model: newModel } : {}),
    ...(effort !== undefined && (effort !== model.effort || newModel !== undefined)
      ? { effort }
      : {}),
    ...(mode !== undefined && mode !== (model.permissionMode ?? CHAT_MODES[agent].fallback)
      ? { mode }
      : {}),
  };
}
