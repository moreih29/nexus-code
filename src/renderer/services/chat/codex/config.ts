// Translate app-server config into the existing chat.config read/write shape.
import type { ChatConfig, RpcParams } from "../../../../../packages/remote-protocol/src";
import type { ModelInfo } from "../model";
import { compareVersions } from "../versions";

// A read-origin binding carried by the existing chat.config record schema.
export const CODEX_CONFIG_PROFILE_KEY = "_codex_profile_id";

export type CodexConfigSet = NonNullable<RpcParams<"chat.config">["set"]>;
export class CodexConfigRefusal extends Error {}

type RecordValue = Record<string, unknown>;
type ConfigKey = ChatConfig["keys"][number];

const numericSettings: Readonly<Record<string, { min: number; max: number }>> = {
  model_auto_compact_token_limit: { min: 1, max: Number.MAX_SAFE_INTEGER },
  model_context_window: { min: 1, max: Number.MAX_SAFE_INTEGER },
  model_post_turn_compact_threshold_percent: { min: 0, max: 100 },
};

const resettableChoices: Readonly<Record<string, readonly string[]>> = {
  model_auto_compact_token_limit_scope: ["total", "body_after_prefix"],
  model_reasoning_summary: ["auto", "concise", "detailed", "none"],
  model_verbosity: ["low", "medium", "high"],
  plan_mode_reasoning_effort: [],
};

/** Undefined is invalid, null removes the override. The peer wire stays text. */
export function codexNumericConfigValue(key: string, value: string): number | null | undefined {
  const range = Object.hasOwn(numericSettings, key) ? numericSettings[key] : undefined;
  if (!range) return undefined;
  if (value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) &&
    String(parsed) === value &&
    parsed >= range.min &&
    parsed <= range.max
    ? parsed
    : undefined;
}

const choices = {
  approval_policy: ["on-request", "never"],
  sandbox_mode: ["read-only", "workspace-write", "danger-full-access"],
  web_search: ["disabled", "cached", "live"],
} as const;

const requirementKeys = {
  approval_policy: "allowedApprovalPolicies",
  sandbox_mode: "allowedSandboxModes",
  web_search: "allowedWebSearchModes",
} as const;

// These values can affect every subsequent thread on this profile. Keep them local.
const remoteBlocked: Readonly<Record<string, string>> = {
  approval_policy: "never",
  sandbox_mode: "danger-full-access",
};

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function tierName(tier: string | undefined): string | undefined {
  return tier === "fast" ? "priority" : tier;
}

export function codexConfigSnapshot(
  result: RecordValue,
  requirementResponse: RecordValue | undefined,
  catalog: readonly ModelInfo[],
  remote: boolean,
  running?: string,
  versionNumber?: string | null,
) {
  const config = record(result.config);
  if (!config) throw new Error("Codex did not return its config");
  const requirements = record(requirementResponse?.requirements);
  const requirementsKnown =
    requirementResponse?.requirements === null || requirements !== undefined;
  const origins = record(result.origins);
  // Layers are in descending precedence. App-server writes the active user
  // layer, which may be a Codex named profile inside this Nexus profile's home.
  const enabledLayers = (Array.isArray(result.layers) ? result.layers.map(record) : []).filter(
    (layer): layer is RecordValue => !!layer && !layer.disabledReason,
  );
  const userLayer = enabledLayers.find((layer) => record(layer.name)?.type === "user");
  const userConfig = record(userLayer?.config);
  const activeProfile = text(record(userLayer?.name)?.profile);
  const filePath = text(record(userLayer?.name)?.file);
  const version = text(userLayer?.version);

  const model = text(config.model) ?? catalog.find((m) => m.isDefault)?.value;
  const modelChoices = catalog.slice(0, 100);
  const models = modelChoices.map(({ value, displayName, supportedEffortLevels }) => ({
    value,
    ...(displayName ? { displayName } : {}),
    ...(supportedEffortLevels ? { supportedEffortLevels } : {}),
  }));

  // Values supplied by stronger layers can be shown but cannot be edited here.
  const isOverridden = (key: string) =>
    Object.entries(origins ?? {}).some(([path, metadata]) => {
      if (path !== key && !path.startsWith(`${key}.`)) return false;
      const layer = record(record(metadata)?.name);
      return (
        layer !== undefined &&
        (layer.type === "user"
          ? !!layer.profile && layer.profile !== activeProfile
          : layer.type !== "system" && layer.type !== "packagedDefaults")
      );
    });

  const keyOf = (
    key: string,
    group: ConfigKey["group"],
    value: string | undefined,
    options: readonly string[],
  ): ConfigKey => ({
    key,
    group,
    kind: "choice",
    options: isOverridden(key) ? [] : options.filter((v) => !remote || remoteBlocked[key] !== v),
    ...(value ? { value: value.slice(0, 1000) } : {}),
  });

  const features = record(config.features);
  const requiredFeatures = record(requirements?.featureRequirements);
  const fastAllowed = (tier: string) => {
    const key =
      tier === "priority" || requirementResponse?.supportsIndependentSpeedModes !== true
        ? "fast_mode"
        : "ultrafast_mode";
    return (requiredFeatures?.[key] ?? features?.[key]) !== false;
  };
  const tiersFor = (selected: string | undefined): string[] => {
    const entry = modelChoices.find((m) => m.value === selected);
    const tiers = (entry?.serviceTiers ?? [])
      .map((id) => tierName(id) ?? id)
      .filter((tier) => !["priority", "ultrafast"].includes(tier) || fastAllowed(tier));
    return tiers.length || text(config.service_tier) ? [...new Set(["default", ...tiers])] : [];
  };

  // The batch sets a profile default. A trusted project or this server's
  // flags can narrow the sandbox locally while another thread inherits
  // broader settings from the profile. Check both scopes.
  const workspaceWrite = record(config.sandbox_workspace_write);
  const profileWorkspaceWrite = enabledLayers.flatMap<RecordValue>((layer) => {
    const type = record(layer.name)?.type;
    if (type === "project" || type === "sessionFlags") return [];
    return record(record(layer.config)?.sandbox_workspace_write) ?? [];
  });
  const profileNetwork = profileWorkspaceWrite.find((value) =>
    Object.hasOwn(value, "network_access"),
  )?.network_access;
  const profileRoots = profileWorkspaceWrite.find((value) =>
    Object.hasOwn(value, "writable_roots"),
  )?.writable_roots;
  const widerWorkspaceWrite =
    workspaceWrite?.network_access === true ||
    profileNetwork === true ||
    [workspaceWrite?.writable_roots, profileRoots].some(
      (roots) => Array.isArray(roots) && roots.length > 0,
    );

  const keys = [
    keyOf(
      "model",
      "conversation",
      model,
      models.map((m) => m.value),
    ),
  ];
  for (const key of Object.keys(choices) as (keyof typeof choices)[]) {
    if (!Object.hasOwn(config, key)) continue;
    const allowed = requirements?.[requirementKeys[key]];
    const supported: readonly string[] =
      key === "web_search" &&
      ((versionNumber && compareVersions(versionNumber, "0.170.0") >= 0) ||
        config.web_search === "indexed" ||
        (Array.isArray(allowed) && allowed.includes("indexed")))
        ? [...choices[key], "indexed"]
        : choices[key];
    const options = supported.filter(
      (value) =>
        ((key === "web_search" && value === "disabled") ||
          !Array.isArray(allowed) ||
          allowed.includes(value)) &&
        !(remote && key === "sandbox_mode" && widerWorkspaceWrite && value === "workspace-write"),
    );
    const namedPermissions =
      key === "sandbox_mode" &&
      (config.default_permissions != null || requirements?.defaultPermissions != null);
    const value =
      text(config[key]) ??
      (key === "approval_policy" && record(config[key])?.granular ? "granular" : undefined);
    keys.push(keyOf(key, "work", value, requirementsKnown && !namedPermissions ? options : []));
  }
  if (Object.hasOwn(config, "service_tier")) {
    const value = tierName(text(config.service_tier));
    const tiers = tiersFor(model);
    if (value || tiers.length)
      keys.push(keyOf("service_tier", "conversation", value, requirementsKnown ? tiers : []));
  }

  // Older servers omit keys their config loader does not know. 0.170 also
  // advertises its typed TOML fields in config/read's flattened properties.
  for (const key of Object.keys(numericSettings)) {
    if (!Object.hasOwn(config, key)) continue;
    const raw = config[key];
    const value = typeof raw === "number" ? String(raw) : undefined;
    const available = value !== undefined && codexNumericConfigValue(key, value) !== undefined;
    keys.push({
      key,
      group: "conversation",
      kind: "text",
      ...(isOverridden(key) ? { options: [] } : {}),
      ...(available ? { value } : raw == null ? {} : { valueUnavailable: true }),
    });
  }
  const planEffortsFor = (selected: string | undefined) =>
    models.find((entry) => entry.value === selected)?.supportedEffortLevels ?? [];
  for (const [key, values] of Object.entries(resettableChoices)) {
    if (!Object.hasOwn(config, key)) continue;
    const value = text(config[key]);
    const options = key === "plan_mode_reasoning_effort" ? planEffortsFor(model) : values;
    if (value || options.length) {
      keys.push(keyOf(key, "conversation", value, ["default", ...options]));
    }
  }

  const effort = text(config.model_reasoning_effort);
  const shown: ChatConfig = {
    keys,
    ...(running ? { model: running } : {}),
    models,
    ...(!isOverridden("model_reasoning_effort")
      ? { efforts: { ...(effort ? { level: effort } : {}), byModel: {} } }
      : {}),
  };
  return { shown, version, filePath, tiersFor, planEffortsFor, userConfig };
}

/** Revalidate every field on the host before issuing one config/batchWrite. */
export function codexConfigEdits(
  set: CodexConfigSet,
  { shown, tiersFor, planEffortsFor, userConfig }: ReturnType<typeof codexConfigSnapshot>,
  remote: boolean,
) {
  const model = set.changes.model ?? shown.keys.find((key) => key.key === "model")?.value;
  const selected = typeof model === "string" ? model : undefined;
  const changes: { keyPath: string; value: string | number | null; mergeStrategy: "replace" }[] =
    [];
  const edit = (keyPath: string, value: string | number | null) =>
    changes.push({ keyPath, value, mergeStrategy: "replace" });
  const reset = (field: ConfigKey) => {
    const overridden = userConfig
      ? Object.hasOwn(userConfig, field.key)
      : field.value !== undefined || field.valueUnavailable;
    if (overridden) edit(field.key, null);
  };

  for (const [key, value] of Object.entries(set.changes)) {
    const field = shown.keys.find((field) => field.key === key);
    if (!field || typeof value !== "string")
      throw new CodexConfigRefusal(`Unsupported Codex config setting: ${key}`);
    if (remote && remoteBlocked[key] === value)
      throw new CodexConfigRefusal(`Change ${key} to ${value} on the host computer`);
    if (value === field.value) continue;
    if (field.kind === "text") {
      const parsed = codexNumericConfigValue(key, value);
      if (field.options?.length === 0) throw new CodexConfigRefusal(`${key} is read-only`);
      if (parsed === undefined)
        throw new CodexConfigRefusal(`${key} requires a whole number in its supported range`);
      if (parsed === null) reset(field);
      else edit(key, parsed);
      continue;
    }
    if (
      Object.hasOwn(resettableChoices, key) &&
      value === "default" &&
      field.options?.includes(value)
    ) {
      reset(field);
      continue;
    }
    if (
      !field.options?.includes(value) ||
      (key === "service_tier" && !tiersFor(selected).includes(value)) ||
      (key === "plan_mode_reasoning_effort" && !planEffortsFor(selected).includes(value))
    )
      throw new CodexConfigRefusal(`${key} does not allow "${value}"`);
    // Use the CLI's TOML spelling for Fast, including on older Codex versions.
    edit(key, key === "service_tier" && value === "priority" ? "fast" : value);
  }
  const { effort } = set;
  if (
    effort !== undefined &&
    (effort !== shown.efforts?.level || set.changes.model !== undefined)
  ) {
    const levels = shown.models.find((entry) => entry.value === selected)?.supportedEffortLevels;
    if (!shown.efforts || !levels?.includes(effort))
      throw new CodexConfigRefusal(`The default effort cannot be "${effort}"`);
    if (effort !== shown.efforts.level) edit("model_reasoning_effort", effort);
  }
  return changes;
}
