import { type ChatModel, currentModelInfo } from "./model";

/**
 * The side panel's model line: "model · effort". The effort joins only when
 * one is set and the model takes efforts: `efforts` is the list it offers, and
 * left out where the list is unknown (a peer's tab), a set effort is enough.
 */
export function modelLineOf(
  model: string | undefined,
  effort: string | undefined,
  efforts?: readonly string[],
): string | undefined {
  if (!model) return undefined;
  if (!effort || (efforts && efforts.length === 0)) return model;
  return `${model} · ${effort}`;
}

/** The model line of a tab's state, its efforts read from the models its program listed. */
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
