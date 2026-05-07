// Server-initiated request handlers — handles requests that the LSP server sends
// back to the client (configuration lookups, capability registration, edit application,
// message dialogs, progress tokens).

import {
  ApplyWorkspaceEditParamsSchema,
  type ApplyWorkspaceEditResult,
  ApplyWorkspaceEditResultSchema,
  ConfigurationParamsSchema,
  type LspServerEventMethod,
  type Registration,
  RegistrationParamsSchema,
  ShowMessageRequestParamsSchema,
  WorkDoneProgressCreateParamsSchema,
} from "../../shared/lsp-types";

const WATCHED_FILES_METHOD = "workspace/didChangeWatchedFiles";

// ---------------------------------------------------------------------------
// Config flatten/lookup helpers
// ---------------------------------------------------------------------------

function isPlainConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function flattenInitializationOptions(
  value: unknown,
  prefix = "",
  output = new Map<string, unknown>(),
): Map<string, unknown> {
  if (!isPlainConfigObject(value)) {
    if (prefix.length > 0) output.set(prefix, value);
    return output;
  }

  for (const [key, child] of Object.entries(value)) {
    const childKey = prefix.length > 0 ? `${prefix}.${key}` : key;
    if (isPlainConfigObject(child)) {
      flattenInitializationOptions(child, childKey, output);
    } else {
      output.set(childKey, child);
    }
  }
  return output;
}

function setNestedConfigValue(
  target: Record<string, unknown>,
  pathParts: string[],
  value: unknown,
) {
  let cursor = target;
  for (let index = 0; index < pathParts.length - 1; index += 1) {
    const part = pathParts[index];
    const existing = cursor[part];
    if (!isPlainConfigObject(existing)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  const leaf = pathParts.at(-1);
  if (leaf !== undefined) {
    cursor[leaf] = value;
  }
}

export function lookupFlattenedConfig(flatConfig: Map<string, unknown>, section: string): unknown {
  if (flatConfig.has(section)) return flatConfig.get(section);

  const prefix = `${section}.`;
  const sectionValue: Record<string, unknown> = {};
  let found = false;
  for (const [key, value] of flatConfig) {
    if (!key.startsWith(prefix)) continue;
    found = true;
    setNestedConfigValue(sectionValue, key.slice(prefix.length).split("."), value);
  }
  return found ? sectionValue : null;
}

// ---------------------------------------------------------------------------
// Context interface
// ---------------------------------------------------------------------------

// Minimal surface of LspManager needed by these handlers.
export interface ServerHandlerContext {
  configurationStore: Map<string, Map<string, Map<string, unknown>>>;
  watchedFileRegistrations: Map<string, Map<string, Registration[]>>;
  send(msg: unknown): void;
  requestMain(method: string, params: unknown): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Handler implementations
// ---------------------------------------------------------------------------

export function handleWorkspaceConfiguration(
  ctx: ServerHandlerContext,
  workspaceId: string,
  presetLanguageId: string,
  params: unknown,
): unknown[] {
  const parsed = ConfigurationParamsSchema.safeParse(params);
  if (!parsed.success) return [];

  const flatConfig = ctx.configurationStore.get(workspaceId)?.get(presetLanguageId);
  return parsed.data.items.map((item) => {
    if (!flatConfig || typeof item.section !== "string" || item.section.length === 0) {
      return null;
    }
    return lookupFlattenedConfig(flatConfig, item.section);
  });
}

export function handleClientRegisterCapability(
  ctx: ServerHandlerContext,
  workspaceId: string,
  presetLanguageId: string,
  params: unknown,
): null {
  const parsed = RegistrationParamsSchema.safeParse(params);
  if (!parsed.success) return null;

  const watchedFileRegistrations = parsed.data.registrations.filter(
    (registration) => registration.method === WATCHED_FILES_METHOD,
  );
  if (watchedFileRegistrations.length === 0) return null;

  let workspaceRegistrations = ctx.watchedFileRegistrations.get(workspaceId);
  if (!workspaceRegistrations) {
    workspaceRegistrations = new Map<string, Registration[]>();
    ctx.watchedFileRegistrations.set(workspaceId, workspaceRegistrations);
  }

  const existing = workspaceRegistrations.get(presetLanguageId) ?? [];
  workspaceRegistrations.set(presetLanguageId, existing.concat(watchedFileRegistrations));
  return null;
}

export async function handleWorkspaceApplyEdit(
  ctx: ServerHandlerContext,
  params: unknown,
): Promise<ApplyWorkspaceEditResult> {
  const parsed = ApplyWorkspaceEditParamsSchema.safeParse(params);
  if (!parsed.success) {
    return { applied: false, failureReason: "Invalid workspace/applyEdit params" };
  }

  try {
    const result = await ctx.requestMain("workspace/applyEdit", parsed.data);
    const parsedResult = ApplyWorkspaceEditResultSchema.safeParse(result);
    if (parsedResult.success) return parsedResult.data;
    return { applied: false, failureReason: "Invalid workspace/applyEdit response" };
  } catch (error) {
    return {
      applied: false,
      failureReason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function handleShowMessageRequest(
  ctx: ServerHandlerContext,
  workspaceId: string,
  presetLanguageId: string,
  params: unknown,
): unknown {
  forwardServerEvent(ctx, workspaceId, presetLanguageId, "window/showMessageRequest", params);

  const parsed = ShowMessageRequestParamsSchema.safeParse(params);
  if (!parsed.success) return null;
  return parsed.data.actions?.[0] ?? null;
}

export function handleWorkDoneProgressCreate(
  ctx: ServerHandlerContext,
  workspaceId: string,
  presetLanguageId: string,
  params: unknown,
): null {
  const parsed = WorkDoneProgressCreateParamsSchema.safeParse(params);
  forwardServerEvent(
    ctx,
    workspaceId,
    presetLanguageId,
    "window/workDoneProgress/create",
    parsed.success ? parsed.data : params,
  );
  return null;
}

export function forwardServerEvent(
  ctx: ServerHandlerContext,
  workspaceId: string,
  languageId: string,
  method: LspServerEventMethod,
  params: unknown,
): void {
  ctx.send({
    type: "serverEvent",
    workspaceId,
    languageId,
    method,
    params,
  });
}
