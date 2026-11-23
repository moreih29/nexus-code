import type { ModelInfo } from "../model";

export interface ContinuedCodexChoices {
  model?: string;
  effort?: string;
  readOnly?: boolean;
}

const LEGACY_SANDBOXES: Readonly<Record<string, string>> = {
  readOnly: "read-only",
  workspaceWrite: "workspace-write",
  dangerFullAccess: "danger-full-access",
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function profileForkSettings(
  defaults: Record<string, unknown>,
  chosen: ContinuedCodexChoices,
  models: readonly ModelInfo[],
) {
  const { approvalPolicy, approvalsReviewer, activePermissionProfile, runtimeWorkspaceRoots } =
    defaults;
  const policyId = record(activePermissionProfile)?.id;
  const sandbox = record(defaults.sandbox);
  const sandboxType = typeof sandbox?.type === "string" ? sandbox.type : "";
  const legacyMode = LEGACY_SANDBOXES[sandboxType];
  if (
    (typeof approvalPolicy !== "string" && !record(approvalPolicy)) ||
    (typeof policyId !== "string" && !legacyMode)
  ) {
    throw new Error("Codex did not resolve the destination profile's permissions");
  }

  const keepReadOnly =
    chosen.readOnly &&
    !policyId &&
    (legacyMode === "workspace-write" || legacyMode === "danger-full-access");
  const model = models.find((entry) => entry.value === chosen.model)?.value ?? defaults.model;
  const efforts = models.find((entry) => entry.value === model)?.supportedEffortLevels;
  const defaultEffort = defaults.reasoningEffort;
  const effort =
    chosen.effort && efforts?.includes(chosen.effort)
      ? chosen.effort
      : model === defaults.model ||
          (typeof defaultEffort === "string" && efforts?.includes(defaultEffort))
        ? defaultEffort
        : undefined;
  const config = {
    ...(typeof effort === "string" ? { model_reasoning_effort: effort } : {}),
    ...(!policyId && !keepReadOnly && legacyMode === "workspace-write" && sandbox
      ? {
          sandbox_workspace_write: {
            writable_roots: Array.isArray(sandbox.writableRoots) ? sandbox.writableRoots : [],
            network_access: sandbox.networkAccess === true,
            exclude_tmpdir_env_var: sandbox.excludeTmpdirEnvVar === true,
            exclude_slash_tmp: sandbox.excludeSlashTmp === true,
          },
        }
      : {}),
  };
  return {
    approvalPolicy,
    ...(typeof approvalsReviewer === "string" ? { approvalsReviewer } : {}),
    ...(typeof policyId === "string"
      ? { permissions: policyId }
      : { sandbox: keepReadOnly ? "read-only" : legacyMode }),
    ...(Array.isArray(runtimeWorkspaceRoots) ? { runtimeWorkspaceRoots } : {}),
    ...(typeof model === "string" ? { model } : {}),
    ...(Object.keys(config).length ? { config } : {}),
    deferGoalContinuation: true,
  };
}

function sameApprovalPolicy(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  const left = record(record(actual)?.granular);
  const right = record(record(expected)?.granular);
  return (
    !!left &&
    !!right &&
    Object.keys(left).length === Object.keys(right).length &&
    Object.entries(right).every(([key, value]) => left[key] === value)
  );
}

export function matchesProfileForkSettings(
  request: Record<string, unknown>,
  response: Record<string, unknown>,
): boolean {
  if (request.approvalPolicy === undefined) return true;
  if (!sameApprovalPolicy(response.approvalPolicy, request.approvalPolicy)) return false;
  if (
    request.approvalsReviewer !== undefined &&
    response.approvalsReviewer !== request.approvalsReviewer
  )
    return false;
  if (typeof request.permissions === "string")
    return record(response.activePermissionProfile)?.id === request.permissions;
  const sandbox = record(response.sandbox);
  const type = sandbox?.type;
  if (typeof type !== "string" || LEGACY_SANDBOXES[type] !== request.sandbox) return false;
  if (type === "readOnly") return sandbox?.networkAccess !== true;
  const workspace = record(record(request.config)?.sandbox_workspace_write);
  return !workspace || workspace.network_access === true || sandbox?.networkAccess !== true;
}
