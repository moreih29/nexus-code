/**
 * A Claude or Codex tab's model, effort and permission mode as the nexus
 * CLI reads and sets them: what the tab runs with and takes, as its
 * composer's chips list them, and what a set asks of it. Pure.
 */

import type { CliChatChoices, CliChatSettings } from "../../../shared/cli/ui";
import { CHAT_MODES, chatModeNamed } from "../../../shared/sessions/chat-modes";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import { type ChatModel, currentModelInfo, type ModelInfo } from "../chat/model";

/** What a tab runs with now, and what it may be set to. */
export function chatChoicesOf(agent: ChatAgent, model: ChatModel): CliChatChoices {
  const models = model.init?.models ?? [];
  const current = currentModelInfo(models, model.model, model.chosenModel);
  return {
    agent,
    model: current?.value ?? model.model ?? null,
    effort: model.effort ?? null,
    mode: model.permissionMode ?? CHAT_MODES[agent].fallback,
    models: models.map((m) => ({ value: m.value, name: m.displayName ?? m.value })),
    efforts: current?.supportedEffortLevels ?? [],
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

function modelNamed(models: readonly ModelInfo[], name: string): ModelInfo | undefined {
  const lower = name.trim().toLowerCase();
  return (
    models.find((m) => m.value.toLowerCase() === lower) ??
    models.find((m) => m.displayName?.toLowerCase() === lower) ??
    models.find((m) => m.resolvedModel?.toLowerCase() === lower)
  );
}

/**
 * What setting `wanted` asks of the tab, in the names its program takes.
 * Throws an Error saying what is wrong: a model it does not offer, an
 * effort the model does not take, an unknown mode, or the mode that lets
 * everything run, which is the user's to pick.
 */
export function planChatSettings(
  agent: ChatAgent,
  model: ChatModel,
  wanted: CliChatSettings,
  effortSettable: boolean,
  /** The user asks, from another device: the dangerous mode too, unless a policy keeps it off. */
  user = false,
): ChatSettingsPlan {
  const models = model.init?.models ?? [];
  const now = chatChoicesOf(agent, model);
  let nextModel: ModelInfo | undefined;
  if (wanted.model !== undefined) {
    nextModel = modelNamed(models, wanted.model);
    if (!nextModel) {
      throw new Error(
        models.length === 0
          ? "it lists no models to pick from"
          : `it offers no model "${wanted.model}"; it offers ${listed(models.map((m) => m.value))}`,
      );
    }
  }
  const modelInfo = nextModel ?? currentModelInfo(models, model.model, model.chosenModel);
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
    if (mode === set.dangerous && !user) {
      throw new Error(`${mode} lets every tool run unasked; that is the user's to pick in the app`);
    }
    if (mode === set.dangerous && model.bypassBlocked) {
      throw new Error(`${mode} is turned off here: ${model.bypassBlocked}`);
    }
  }
  const newModel = nextModel && nextModel.value !== now.model ? nextModel.value : undefined;
  return {
    ...(newModel !== undefined ? { model: newModel } : {}),
    // A new model may start at its own effort: set again after it.
    ...(effort !== undefined && (effort !== now.effort || newModel !== undefined)
      ? { effort }
      : {}),
    ...(mode !== undefined && mode !== now.mode ? { mode } : {}),
  };
}
