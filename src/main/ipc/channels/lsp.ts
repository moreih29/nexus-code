// LSP IPC channel — bridges renderer ↔ main ↔ utility(lsp-host).
// Renderer calls are forwarded to the lsp host via the LspHostHandle.
// Utility diagnostics events are broadcast to all renderers.

import { ipcContract } from "../../../shared/ipc-contract";
import type {
  ApplyWorkspaceEditParams,
  ApplyWorkspaceEditResult,
  CompletionItem,
  DocumentHighlight,
  DocumentSymbol,
  HoverResult,
  Location,
  SymbolInformation,
} from "../../../shared/lsp-types";
import { PendingRequestMap } from "../../../shared/pending-request-map";
import type { LspHostHandle } from "../../hosts/lsp-host";
import { broadcast, type CallContext, register, validateArgs } from "../router";

const c = ipcContract.lsp.call;
const APPLY_EDIT_RESPONSE_TIMEOUT_MS = 10_000;

let nextApplyEditRequestId = 1;
const pendingApplyEditRequests = new PendingRequestMap<string, ApplyWorkspaceEditResult>();

function fallbackApplyEditResult(failureReason: string): ApplyWorkspaceEditResult {
  return { applied: false, failureReason };
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

export function registerLspChannel(lspHost: LspHostHandle): void {
  // Forward utility→main diagnostics events to renderers
  lspHost.on("diagnostics", (args) => {
    const { uri, diagnostics } = args as { uri: string; diagnostics: unknown[] };
    broadcast("lsp", "diagnostics", { uri, diagnostics });
  });

  lspHost.on("serverRequest", (args) => {
    handleServerRequest(lspHost, args).catch((error: unknown) => {
      console.warn("[lsp] server request handler failed", error);
    });
  });

  lspHost.on("serverEvent", (args) => {
    broadcast("lsp", "serverEvent", args);
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
        const { uri, version, contentChanges } = validateArgs(c.didChange.args, args);
        await lspHost.call("didChange", { uri, version, contentChanges });
      },

      didSave: async (args: unknown) => {
        const { uri, text } = validateArgs(c.didSave.args, args);
        await lspHost.call("didSave", { uri, text });
      },

      didClose: async (args: unknown) => {
        const { uri } = validateArgs(c.didClose.args, args);
        await lspHost.call("didClose", { uri });
      },

      hover: async (args: unknown, ctx?: CallContext) => {
        const { uri, line, character } = validateArgs(c.hover.args, args);
        const result = await lspHost.call(
          "hover",
          { uri, line, character },
          { signal: ctx?.signal },
        );
        return result as HoverResult | null;
      },

      definition: async (args: unknown, ctx?: CallContext) => {
        const { uri, line, character } = validateArgs(c.definition.args, args);
        const result = await lspHost.call(
          "definition",
          { uri, line, character },
          { signal: ctx?.signal },
        );
        return result as Location[];
      },

      completion: async (args: unknown, ctx?: CallContext) => {
        const { uri, line, character } = validateArgs(c.completion.args, args);
        const result = await lspHost.call(
          "completion",
          { uri, line, character },
          { signal: ctx?.signal },
        );
        return result as CompletionItem[];
      },

      references: async (args: unknown, ctx?: CallContext) => {
        const { uri, line, character, includeDeclaration } = validateArgs(c.references.args, args);
        const result = await lspHost.call(
          "references",
          { uri, line, character, includeDeclaration },
          { signal: ctx?.signal },
        );
        return result as Location[];
      },

      documentHighlight: async (args: unknown, ctx?: CallContext) => {
        const { uri, line, character } = validateArgs(c.documentHighlight.args, args);
        const result = await lspHost.call(
          "documentHighlight",
          { uri, line, character },
          { signal: ctx?.signal },
        );
        return result as DocumentHighlight[];
      },

      documentSymbol: async (args: unknown, ctx?: CallContext) => {
        const { uri } = validateArgs(c.documentSymbol.args, args);
        const result = await lspHost.call("documentSymbol", { uri }, { signal: ctx?.signal });
        return result as DocumentSymbol[];
      },

      workspaceSymbol: async (args: unknown, ctx?: CallContext) => {
        const { workspaceId, query } = validateArgs(c.workspaceSymbol.args, args);
        const result = await lspHost.call(
          "workspaceSymbol",
          { workspaceId, query },
          { signal: ctx?.signal },
        );
        return result as SymbolInformation[];
      },

      applyEditResult: async (args: unknown) => {
        const { requestId, result } = validateArgs(c.applyEditResult.args, args);
        resolveRendererApplyEdit(requestId, result);
      },
    },
    listen: {
      diagnostics: {},
      applyEdit: {},
      serverEvent: {},
    },
  });
}
