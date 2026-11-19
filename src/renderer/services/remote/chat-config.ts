/**
 * A Claude chat's Claude Code settings (/config) between devices
 * (chat.config): what the computer it runs on tells of them, read as its
 * settings dialog reads them, and what another device's dialog shows of
 * that; and the changes that dialog saves, checked against the keys there
 * before they go out as /config messages.
 */

import type { ChatConfig } from "../../../../packages/remote-protocol/src";
import {
  type ConfigShown,
  type ConfigValue,
  changesOf,
  choicesOf,
  configKeysOf,
  configMessages,
  configValues,
  defaultEffortLevels,
  effortModelOf,
  type ListedKey,
} from "../chat/claude/config";
import type { ModelInfo } from "../chat/model";

/** The longest value told: a setting's text is a few words. */
const MAX_VALUE = 1000;

/** What the settings dialog read, as a chat's settings are told. */
export function chatConfigOf(read: {
  effective: Readonly<Record<string, unknown>>;
  global: Readonly<Record<string, unknown>>;
  model?: string;
  listed: readonly ListedKey[] | null;
  models: readonly ModelInfo[];
  outputStyles?: readonly string[];
  /** Whether its program can save a default effort. */
  effort: boolean;
}): ChatConfig {
  const keys = configKeysOf(read.listed);
  const values = configValues(read.effective, read.global, keys);
  return {
    keys: keys.map((key) => {
      const value = values[key.key];
      return {
        key: key.key,
        group: key.group,
        kind: key.kind,
        ...(key.options ? { options: [...key.options] } : {}),
        ...(value !== undefined
          ? { value: typeof value === "string" ? value.slice(0, MAX_VALUE) : value }
          : {}),
      };
    }),
    ...(read.model ? { model: read.model } : {}),
    models: read.models.map((m) => ({
      value: m.value,
      ...(m.displayName ? { displayName: m.displayName } : {}),
      ...(m.resolvedModel ? { resolvedModel: m.resolvedModel } : {}),
      ...(m.supportedEffortLevels ? { supportedEffortLevels: [...m.supportedEffortLevels] } : {}),
    })),
    ...(read.outputStyles?.length ? { outputStyles: [...read.outputStyles] } : {}),
    ...(read.effort ? { efforts: effortsOf(read.effective) } : {}),
  };
}

/** The default efforts the settings give: the one for any model, and each model's own. */
function effortsOf(
  effective: Readonly<Record<string, unknown>>,
): NonNullable<ChatConfig["efforts"]> {
  const byModel: Record<string, string> = {};
  const perModel = effective.modelSettings;
  if (typeof perModel === "object" && perModel !== null) {
    for (const [id, settings] of Object.entries(perModel)) {
      const level = (settings as { effortLevel?: unknown } | null)?.effortLevel;
      if (typeof level === "string" && level) byModel[id] = level;
    }
  }
  const level = effective.effortLevel;
  return { ...(typeof level === "string" && level ? { level } : {}), byModel };
}

/** What another device's settings dialog shows of a chat's settings told. */
export function configShownOf(config: ChatConfig): ConfigShown {
  const efforts = config.efforts;
  return {
    keys: config.keys.map(({ key, group, kind, options }) => ({
      key,
      group,
      kind,
      ...(options ? { options } : {}),
    })),
    values: Object.fromEntries(config.keys.map((k) => [k.key, k.value])),
    // As defaultEffortOf reads Claude Code's settings.
    effective: efforts
      ? {
          ...(efforts.level ? { effortLevel: efforts.level } : {}),
          modelSettings: Object.fromEntries(
            Object.entries(efforts.byModel).map(([id, effortLevel]) => [id, { effortLevel }]),
          ),
        }
      : {},
    ...(config.model ? { model: config.model } : {}),
    effort: efforts !== undefined,
    models: config.models,
    ...(config.outputStyles ? { outputStyles: config.outputStyles } : {}),
  };
}

/** A change another device asked for that the settings do not take, with why. */
export class ConfigRefusal extends Error {}

/**
 * The /config messages that save another device's changes, checked as the
 * dialog here would let them be made: each a key it shows, of the kind it
 * takes, a choice one of its choices, and a default effort one the model
 * then run takes. The permission mode that lets everything run is not set
 * from another device.
 */
export function configSetOf(
  set: { changes: Readonly<Record<string, ConfigValue>>; effort?: string },
  config: ChatConfig,
): { messages: string[]; model?: string; effort?: string } {
  const { changes, effort } = set;
  const shown = configShownOf(config);
  const byKey = new Map(shown.keys.map((k) => [k.key, k]));
  for (const [name, value] of Object.entries(changes)) {
    const key = byKey.get(name);
    if (!key) throw new ConfigRefusal(`there is no setting "${name}"`);
    if (key.kind === "boolean" ? typeof value !== "boolean" : typeof value !== "string") {
      throw new ConfigRefusal(
        `"${name}" takes ${key.kind === "boolean" ? "true or false" : "text"}`,
      );
    }
    if (
      key.kind === "choice" &&
      !choicesOf(key, shown.values[name], config.outputStyles).includes(value as string)
    ) {
      throw new ConfigRefusal(`"${name}" cannot be "${String(value)}"`);
    }
    if (name === "permissionMode" && value === "bypassPermissions") {
      throw new ConfigRefusal("the mode that lets everything run is not set from another device");
    }
  }
  const changed = changesOf(changes, shown.values);
  const model = typeof changed.model === "string" ? changed.model : undefined;
  if (effort !== undefined) {
    const levels = shown.effort
      ? defaultEffortLevels(
          effortModelOf(model, config.model, config.models)?.info?.supportedEffortLevels,
        )
      : [];
    if (!levels.includes(effort))
      throw new ConfigRefusal(`the default effort cannot be "${effort}"`);
  }
  return {
    messages: configMessages(changed, shown.keys),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}
