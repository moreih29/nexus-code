import { ipcContract } from "../../../shared/ipc/contract";
import { PendingRequestMap } from "../../../shared/ipc/pending-request-map";
import { createLogger } from "../../../shared/log/main";
import type {
  ApplyWorkspaceEditParams,
  ApplyWorkspaceEditResult,
  CompletionItem,
  CompletionList,
  DocumentHighlight,
  DocumentSymbol,
  HoverResult,
  Location,
  SemanticTokensResult,
  SignatureHelp,
  SymbolInformation,
} from "../../../shared/lsp";
import { isLspLowMemory, lspSettingsFromState } from "../../../shared/lsp/settings";
import type { LspServerStatus } from "../../../shared/lsp/status";
import type { AppState } from "../../../shared/types/app-state";
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

export async function withCancelDefault<T>(
  promise: Promise<unknown>,
  signal: AbortSignal | undefined,
  emptyValue: T,
): Promise<T> {
  try {
    return (await promise) as T;
  } catch (error) {
    if (signal?.aborted) return emptyValue;
    if (error instanceof LspRequestTimeoutError) {
      log.warn(`${error.message} — returning empty result`);
      return emptyValue;
    }
    throw error;
  }
}

async function requestRendererApplyEdit(
  workspaceId: string,
  params: ApplyWorkspaceEditParams,
): Promise<ApplyWorkspaceEditResult> {
  const requestId = `apply-edit-${nextApplyEditRequestId++}`;
  const promise = pendingApplyEditRequests.register({
    key: requestId,
    timeoutMs: APPLY_EDIT_RESPONSE_TIMEOUT_MS,
  });
  broadcast("lsp", "applyEdit", { requestId, workspaceId, params });
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
  const request = args as {
    id?: unknown;
    workspaceId?: unknown;
    method?: unknown;
    params?: unknown;
  };
  const id = request.id;
  if (typeof id !== "string" && typeof id !== "number") return;

  if (request.method !== "workspace/applyEdit") {
    lspHost.rejectServerRequest(id, `unsupported server request: ${String(request.method)}`);
    return;
  }

  if (typeof request.workspaceId !== "string") {
    lspHost.respondServerRequest(id, fallbackApplyEditResult("Missing workspace for applyEdit"));
    return;
  }

  try {
    const params = request.params as ApplyWorkspaceEditParams;
    const result = await requestRendererApplyEdit(request.workspaceId, params);
    lspHost.respondServerRequest(id, result);
  } catch (error) {
    lspHost.respondServerRequest(
      id,
      fallbackApplyEditResult(error instanceof Error ? error.message : String(error)),
    );
  }
}

export function registerLspChannel(lspHost: LspHostHandle, stateService: StateService): void {
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

  lspHost.on("workspaceLspReset", (args) => {
    const { workspaceId, languageId, reopen } = args as {
      workspaceId: string;
      languageId?: string;
      reopen?: boolean;
    };
    broadcast("lsp", "workspaceReset", {
      workspaceId,
      ...(languageId ? { languageId } : {}),
      ...(reopen ? { reopen } : {}),
    });
  });

  lspHost.on("serverStatus", (status) => {
    broadcast("lsp", "serverStatus", status as LspServerStatus);
  });

  function saveSettings(patch: Partial<AppState>): void {
    stateService.setState(patch);
    broadcast("lsp", "settingsChanged", lspSettingsFromState(stateService.getState()));
  }

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
        const { workspaceId, uri, line, character, triggerKind, triggerCharacter } = validateArgs(
          c.completion.args,
          args,
        );
        return withCancelDefault<CompletionList>(
          lspHost.call(
            "completion",
            { workspaceId, uri, line, character, triggerKind, triggerCharacter },
            { signal: ctx?.signal },
          ),
          ctx?.signal,
          { isIncomplete: false, items: [] },
        );
      },

      completionResolve: async (args: unknown, ctx?: CallContext) => {
        const { workspaceId, uri, item } = validateArgs(c.completionResolve.args, args);
        return withCancelDefault<CompletionItem>(
          lspHost.call("completionResolve", { workspaceId, uri, item }, { signal: ctx?.signal }),
          ctx?.signal,
          item,
        );
      },

      signatureHelp: async (args: unknown, ctx?: CallContext) => {
        const parsed = validateArgs(c.signatureHelp.args, args);
        return withCancelDefault<SignatureHelp | null>(
          lspHost.call("signatureHelp", parsed, { signal: ctx?.signal }),
          ctx?.signal,
          null,
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

      setEnabled: async (args: unknown) => {
        const { enabled } = validateArgs(c.setEnabled.args, args);
        saveSettings({ lspEnabled: enabled });
        if (!enabled) lspHost.disposeServers(() => true, "off");
      },

      setLanguageSettings: async (args: unknown) => {
        const { languageId, settings } = validateArgs(c.setLanguageSettings.args, args);
        const languages = stateService.getState().lspLanguages ?? {};
        const previous = languages[languageId] ?? {};
        saveSettings({
          lspLanguages: { ...languages, [languageId]: { ...previous, ...settings } },
        });
        const sameLanguage = (_workspaceId: string, id: string) => id === languageId;
        if (settings.enabled === false) {
          lspHost.disposeServers(sameLanguage, "off");
        } else if (
          (settings.lowMemory !== undefined && settings.lowMemory !== isLspLowMemory(previous)) ||
          (settings.path !== undefined && settings.path.trim() !== (previous.path ?? "").trim())
        ) {
          lspHost.disposeServers(sameLanguage, "restart", { reopen: true });
        }
      },

      setMaxActiveWorkspaces: async (args: unknown) => {
        const { count } = validateArgs(c.setMaxActiveWorkspaces.args, args);
        saveSettings({ lspMaxActiveWorkspaces: count });
        lspHost.enforceMaxActiveWorkspaces();
      },

      setWorkspaceLanguageEnabled: async (args: unknown) => {
        const { workspaceId, languageId, enabled } = validateArgs(
          c.setWorkspaceLanguageEnabled.args,
          args,
        );
        const byWorkspace = stateService.getState().lspDisabledLanguagesByWorkspace ?? {};
        const others = (byWorkspace[workspaceId] ?? []).filter((id) => id !== languageId);
        const disabled = enabled ? others : [...others, languageId];
        const { [workspaceId]: _previous, ...rest } = byWorkspace;
        saveSettings({
          lspDisabledLanguagesByWorkspace:
            disabled.length > 0 ? { ...rest, [workspaceId]: disabled } : rest,
        });
        if (!enabled) lspHost.disposeLanguage(workspaceId, languageId, "off");
      },

      restartServer: async (args: unknown) => {
        const { workspaceId, languageId } = validateArgs(c.restartServer.args, args);
        lspHost.restartLanguage(workspaceId, languageId);
      },

      serverStatuses: async () => lspHost.serverStatuses(),

      serverLog: async (args: unknown) => {
        const { workspaceId, languageId, afterSeq } = validateArgs(c.serverLog.args, args);
        return lspHost.serverLog(workspaceId, languageId, afterSeq);
      },

      serverMemory: async (args: unknown) => {
        const { workspaceId } = validateArgs(c.serverMemory.args, args);
        return lspHost.serverMemory(workspaceId);
      },
    },
    listen: {
      diagnostics: {},
      applyEdit: {},
      serverEvent: {},
      "bootstrap.progress": {},
      workspaceReset: {},
      settingsChanged: {},
      serverStatus: {},
    },
  });
}
