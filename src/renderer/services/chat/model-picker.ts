import type { ChatAgent } from "../../../shared/sessions/task-agent";
import { claudeModelLabel } from "./claude/settings-defaults";
import { type ChatModel, currentModelInfo, type ModelInfo } from "./model";

export interface ModelPickerContext {
  readonly profileDefault?: string;
  readonly fallbackModels?: readonly ModelInfo[];
  readonly defaultLabel?: string;
}

/** The model and choices shown by a tab's composer and served to its clients. */
export function modelPickerOf(
  agent: ChatAgent,
  model: Pick<ChatModel, "init" | "model" | "chosenModel">,
  { profileDefault, fallbackModels, defaultLabel = "Default" }: ModelPickerContext = {},
) {
  const models = model.init?.models.length ? model.init.models : (fallbackModels ?? []);
  const configured = models.find(({ value }) => value === profileDefault);
  const selected = currentModelInfo(models, model.model, model.chosenModel);
  const usingDefault = !model.model || model.model === "default" || selected?.value === "default";
  const currentEntry = usingDefault ? (configured ?? selected) : selected;
  const reportedId = model.model === "default" ? (profileDefault ?? model.model) : model.model;
  const value = currentEntry?.value ?? reportedId ?? profileDefault;
  const name = value ? (agent === "claude" ? claudeModelLabel(value) : value) : undefined;
  // An old Claude log can still name its current model after losing the list.
  const fallback: ModelInfo | undefined =
    agent === "claude" && models.length === 0 && value ? { value, displayName: name } : undefined;
  const current = currentEntry ?? fallback;
  const options = (fallback ? [fallback] : models)
    .filter((entry) => !configured || entry.value !== "default" || entry === configured)
    .map((entry) => {
      const alias =
        profileDefault !== undefined && entry.value === "default" && entry !== configured;
      const label = alias ? claudeModelLabel(profileDefault) : (entry.displayName ?? entry.value);
      const generic = entry.description === `Custom model (${entry.value})`;
      return {
        model: entry,
        label: entry.value === profileDefault || alias ? `${defaultLabel} · ${label}` : label,
        detail: profileDefault !== undefined && (alias || generic) ? undefined : entry.description,
      };
    });
  const label = options.find((option) => option.model === current)?.label ?? name;
  return { models, options, current, value, label };
}
