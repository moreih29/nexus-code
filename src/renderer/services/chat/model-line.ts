import { type ChatModel, currentModelInfo } from "./model";

export function modelLineOf(
  model: string | undefined,
  effort: string | undefined,
  efforts?: readonly string[],
): string | undefined {
  if (!model) return undefined;
  if (!effort || (efforts && efforts.length === 0)) return model;
  return `${model} · ${effort}`;
}

export function modelLineOfTab(
  tab: Pick<ChatModel, "model" | "effort" | "init" | "chosenModel">,
): string | undefined {
  const models = tab.init?.models ?? [];
  const efforts =
    models.length > 0
      ? (currentModelInfo(models, tab.model, tab.chosenModel)?.supportedEffortLevels ?? [])
      : undefined;
  return modelLineOf(tab.model, tab.effort, efforts);
}
