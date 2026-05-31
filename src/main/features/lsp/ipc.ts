// LSP IPC channel — bridges renderer ↔ main ↔ agent-backed LspHostHandle.
// Renderer calls are forwarded to the LSP host, and diagnostics events are
// broadcast to all renderers.

import { ipcContract } from "../../../shared/ipc/contract";
import { PendingRequestMap } from "../../../shared/ipc/pending-request-map";
import { createLogger } from "../../../shared/log/main";
import type {
  ApplyWorkspaceEditParams,
  ApplyWorkspaceEditResult,
  CompletionItem,
  DocumentHighlight,
  DocumentSymbol,
  HoverResult,
  Location,
  SemanticTokensResult,
  SymbolInformation,
} from "../../../shared/lsp";
import { LSP_FEATURE_ENABLED } from "../../../shared/lsp/feature-flag";
import type { LspLanguageId } from "../../../shared/types/app-state";
import { LSP_BOOTSTRAP_PROGRESS_EVENT } from "../../infra/agent/ssh/ssh-bootstrap/index";
import { broadcast, type CallContext, register, validateArgs } from "../../infra/ipc-router";
import type { StateService } from "../../infra/storage/state-service";
import { LspRequestTimeoutError } from "./agent-host";
import type { LspHostHandle } from "./host";

const c = ipcContract.lsp.call;
const log = createLogger("lsp");
const APPLY_EDIT_RESPONSE_TIMEOUT_MS = 10_000;

let nextApplyEditRequestId = 1;
const pendingApplyEditRequests = new PendingRequestMap<string, ApplyWorkspaceEditResult>();

function fallbackApplyEditResult(failureReason: string): ApplyWorkspaceEditResult {
  return { applied: false, failureReason };
}

/**
 * Catches abort-induced rejections from `lspHost.call` so they don't bubble
 * out of the IPC handler. Without this wrapper, electron's `ipcMain.handle`
 * logs every cancellation as `Error occurred in handler for 'ipc:call': Error:
 * Request cancelled` whenever the renderer fires `ipc:cancel` (e.g. ESC after
 * Cmd+Shift+O). The cancel itself is expected — the renderer-side provider
 * already has try/catch that handles an empty result identically to a thrown
 * cancellation, so resolving with the method-appropriate empty value is
 * functionally equivalent and quieter.
 *
 * Non-cancel rejections (LSP server crashed, malformed response, etc.) still
 * propagate — we only treat the rejection as expected when the call's signal
 * is aborted.
 */
export async function withCancelDefault<T>(
  promise: Promise<unknown>,
  signal: AbortSignal | undefined,
  emptyValue: T,
): Promise<T> {
  try {
    return (await promise) as T;
  } catch (error) {
    if (signal?.aborted) return emptyValue;
    // A bounded LSP request that exceeded its wall-clock budget. The
    // renderer's provider was waiting on this — returning the method-
    // appropriate empty value (instead of throwing) lets the hover /
    // completion widget close cleanly. The original cause is logged so
    // operators can correlate with tsserver pressure / memory state.
    if (error instanceof LspRequestTimeoutError) {
      log.warn(`${error.message} — returning empty result`);
      return emptyValue;
    }
    throw error;
  }
}

async function requestRendererApplyEdit(
  params: ApplyWorkspaceEditParams,
): Promise<ApplyWorkspaceEditResult> {
  const requestId = `apply-edit-${nextApplyEditRequestId++}`;
  const promise = pendingApplyEditRequests.register({
    key: requestId,
    timeoutMs: APPLY_EDIT_RESPONSE_TIMEOUT_MS,
  });
  broadcast("lsp", "applyEdit", { requestId, params });
  try {
    return await promise;
  } catch {
    return fallbackApplyEditResult("Timed out waiting for renderer applyEdit response");
  }
}

function resolveRendererApplyEdit(requestId: string, result: ApplyWorkspaceEditResult): void {
  pendingApplyEditRequests.resolve(requestId, result);
}

async function handleServerRequest(lspHost: LspHostHandle, args: unknown): Promise<void> {
  const request = args as { id?: unknown; method?: unknown; params?: unknown };
  const id = request.id;
  if (typeof id !== "string" && typeof id !== "number") return;

  if (request.method !== "workspace/applyEdit") {
    lspHost.rejectServerRequest(id, `unsupported server request: ${String(request.method)}`);
    return;
  }

  try {
    const params = request.params as ApplyWorkspaceEditParams;
    const result = await requestRendererApplyEdit(params);
    lspHost.respondServerRequest(id, result);
  } catch (error) {
    lspHost.respondServerRequest(
      id,
      fallbackApplyEditResult(error instanceof Error ? error.message : String(error)),
    );
  }
}

/**
 * Wire the LSP IPC channel: register every method the renderer can call
 * (call surface) and forward main-side LSP host events (diagnostics,
 * serverRequest, serverStatus, ...) onto the channel as broadcasts.
 * Single entry point so `main/index` can hand the LSP host handle over once
 * during startup and not maintain it per-event.
 */
export function registerLspChannel(lspHost: LspHostHandle, stateService: StateService): void {
  if (!LSP_FEATURE_ENABLED) {
    // Feature gate: LSP is globally disabled. Register only the minimal
    // listen-side stubs so the renderer's ipcListen calls don't error on
    // missing channels, and return empty/noop responses for every call.
    register("lsp", {
      call: {
        didOpen: async () => {},
        didChange: async () => {},
        didSave: async () => {},
        didClose: async () => {},
        hover: async () => null,
        definition: async () => [],
        completion: async () => [],
        references: async () => [],
        documentHighlight: async () => [],
        documentSymbol: async () => [],
        workspaceSymbol: async () => [],
        semanticTokens: async () => null,
        applyEditResult: async () => {},
        getEnabledLanguages: async () => ({ languages: [] }),
        setEnabledLanguages: async () => {},
      },
      listen: {
        diagnostics: {},
        applyEdit: {},
        serverEvent: {},
        "bootstrap.progress": {},
        workspaceReset: {},
        enabledLanguagesChanged: {},
      },
    });
    return;
  }

  // Forward host diagnostics events to renderers. The host's debouncer
  // emits `{ workspaceId, languageId, uri, diagnostics }`; we keep
  // workspaceId so the renderer's listener can reconstruct the
  // workspace-scoped cacheUri for the right Monaco model. Without
  // workspaceId the listener's `workspaceUriFor(undefined, …)` throws
  // immediately ("Cannot read properties of undefined (reading 'length')"
  // from the empty-string guard) and Monaco never receives the markers,
  // which in turn looks to the user like the LSP "just stops responding"
  // after a workspace switch.
  lspHost.on("diagnostics", (args) => {
    const { workspaceId, uri, diagnostics } = args as {
      workspaceId: string;
      uri: string;
      diagnostics: unknown[];
    };
    broadcast("lsp", "diagnostics", { workspaceId, uri, diagnostics });
  });

  lspHost.on("serverRequest", (args) => {
    handleServerRequest(lspHost, args).catch((error: unknown) => {
      log.warn(`server request handler failed: ${(error as Error).message}`);
    });
  });

  lspHost.on("serverEvent", (args) => {
    broadcast("lsp", "serverEvent", args);
  });

  lspHost.on(LSP_BOOTSTRAP_PROGRESS_EVENT, (args) => {
    broadcast("lsp", "bootstrap.progress", args);
  });

  // LRU eviction in the agent host disposes a workspace's LSP servers
  // and emits this event. Forwarding it to the renderer lets the model
  // cache clear `lspOpened` on entries belonging to the evicted
  // workspace, so the next interaction (typing, activation) re-issues
  // didOpen and respawns a fresh server. See LSP_MAX_ACTIVE_WORKSPACES.
  lspHost.on("workspaceLspReset", (args) => {
    const { workspaceId, languageId } = args as {
      workspaceId: string;
      languageId?: string;
    };
    broadcast("lsp", "workspaceReset", { workspaceId, ...(languageId ? { languageId } : {}) });
  });

  register("lsp", {
    call: {
      didOpen: async (args: unknown) => {
        const { workspaceId, workspaceRoot, uri, languageId, version, text } = validateArgs(
          c.didOpen.args,
          args,
        );
        await lspHost.call("didOpen", {
          workspaceId,
          workspaceRoot,
          uri,
          languageId,
          version,
          text,
        });
      },

      didChange: async (args: unknown) => {
        const { workspaceId, uri, version, contentChanges } = validateArgs(c.didChange.args, args);
        await lspHost.call("didChange", { workspaceId, uri, version, contentChanges });
      },

      didSave: async (args: unknown) => {
        const { workspaceId, uri, text } = validateArgs(c.didSave.args, args);
        await lspHost.call("didSave", { workspaceId, uri, text });
      },

      didClose: async (args: unknown) => {
        const { workspaceId, uri } = validateArgs(c.didClose.args, args);
        await lspHost.call("didClose", { workspaceId, uri });
      },

      hover: async (args: unknown, ctx?: CallContext) => {
        const { workspaceId, uri, line, character } = validateArgs(c.hover.args, args);
        return withCancelDefault<HoverResult | null>(
          lspHost.call("hover", { workspaceId, uri, line, character }, { signal: ctx?.signal }),
          ctx?.signal,
          null,
        );
      },

      definition: async (args: unknown, ctx?: CallContext) => {
        const { workspaceId, uri, line, character } = validateArgs(c.definition.args, args);
        return withCancelDefault<Location[]>(
          lspHost.call(
            "definition",
            { workspaceId, uri, line, character },
            { signal: ctx?.signal },
          ),
          ctx?.signal,
          [],
        );
      },

      completion: async (args: unknown, ctx?: CallContext) => {
        const { workspaceId, uri, line, character } = validateArgs(c.completion.args, args);
        return withCancelDefault<CompletionItem[]>(
          lspHost.call(
            "completion",
            { workspaceId, uri, line, character },
            { signal: ctx?.signal },
          ),
          ctx?.signal,
          [],
        );
      },

      references: async (args: unknown, ctx?: CallContext) => {
        const { workspaceId, uri, line, character, includeDeclaration } = validateArgs(
          c.references.args,
          args,
        );
        return withCancelDefault<Location[]>(
          lspHost.call(
            "references",
            { workspaceId, uri, line, character, includeDeclaration },
            { signal: ctx?.signal },
          ),
          ctx?.signal,
          [],
        );
      },

      documentHighlight: async (args: unknown, ctx?: CallContext) => {
        const { workspaceId, uri, line, character } = validateArgs(c.documentHighlight.args, args);
        return withCancelDefault<DocumentHighlight[]>(
          lspHost.call(
            "documentHighlight",
            { workspaceId, uri, line, character },
            { signal: ctx?.signal },
          ),
          ctx?.signal,
          [],
        );
      },

      documentSymbol: async (args: unknown, ctx?: CallContext) => {
        const { workspaceId, uri } = validateArgs(c.documentSymbol.args, args);
        return withCancelDefault<DocumentSymbol[]>(
          lspHost.call("documentSymbol", { workspaceId, uri }, { signal: ctx?.signal }),
          ctx?.signal,
          [],
        );
      },

      workspaceSymbol: async (args: unknown, ctx?: CallContext) => {
        const { workspaceId, query } = validateArgs(c.workspaceSymbol.args, args);
        return withCancelDefault<SymbolInformation[]>(
          lspHost.call("workspaceSymbol", { workspaceId, query }, { signal: ctx?.signal }),
          ctx?.signal,
          [],
        );
      },

      semanticTokens: async (args: unknown, ctx?: CallContext) => {
        const { workspaceId, uri } = validateArgs(c.semanticTokens.args, args);
        return withCancelDefault<SemanticTokensResult | null>(
          lspHost.call("semanticTokens", { workspaceId, uri }, { signal: ctx?.signal }),
          ctx?.signal,
          null,
        );
      },

      applyEditResult: async (args: unknown) => {
        const { requestId, result } = validateArgs(c.applyEditResult.args, args);
        resolveRendererApplyEdit(requestId, result);
      },

      getEnabledLanguages: async (args: unknown) => {
        const { workspaceId } = validateArgs(c.getEnabledLanguages.args, args);
        const state = stateService.getState();
        const languages = (state.lspEnabledLanguagesByWorkspace?.[workspaceId] ??
          []) as LspLanguageId[];
        return { languages };
      },

      setEnabledLanguages: async (args: unknown) => {
        const { workspaceId, languages } = validateArgs(c.setEnabledLanguages.args, args);
        const state = stateService.getState();
        const existing =
          state.lspEnabledLanguagesByWorkspace ?? ({} as Record<string, LspLanguageId[]>);
        const prev = (existing[workspaceId] ?? []) as LspLanguageId[];

        // Persist the new set atomically.
        stateService.setState({
          lspEnabledLanguagesByWorkspace: {
            ...existing,
            [workspaceId]: languages,
          },
        });

        // Dispose servers for any language that was just removed.
        // disposeLanguage emits workspaceLspReset for that language, which
        // the workspaceLspReset listener above forwards to all renderers.
        const newSet = new Set<string>(languages);
        for (const lang of prev) {
          if (!newSet.has(lang)) {
            lspHost.disposeLanguage(workspaceId, lang, "user-toggle-off");
          }
        }

        // Broadcast so all open renderer windows can sync their UI.
        broadcast("lsp", "enabledLanguagesChanged", { workspaceId, languages });
      },
    },
    listen: {
      diagnostics: {},
      applyEdit: {},
      serverEvent: {},
      "bootstrap.progress": {},
      workspaceReset: {},
      enabledLanguagesChanged: {},
    },
  });
}
