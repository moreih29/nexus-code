// LSP IPC channel — bridges renderer ↔ main ↔ utility(lsp-host).
// Renderer calls are forwarded to the lsp host via the LspHostHandle.
// Utility diagnostics events are broadcast to all renderers.

import { ipcContract } from "../../../shared/ipc-contract";
import type {
  ApplyWorkspaceEditParams,
  ApplyWorkspaceEditResult,
  CompletionItem,
  HoverResult,
  Location,
} from "../../../shared/lsp-types";
import type { LspHostHandle } from "../../hosts/lsp-host";
import { broadcast, type CallContext, register, validateArgs } from "../router";

const c = ipcContract.lsp.call;
const APPLY_EDIT_RESPONSE_TIMEOUT_MS = 10_000;

type PendingApplyEditRequest = {
  resolve: (result: ApplyWorkspaceEditResult) => void;
  timeout: ReturnType<typeof setTimeout>;
};

let nextApplyEditRequestId = 1;
const pendingApplyEditRequests = new Map<string, PendingApplyEditRequest>();

function fallbackApplyEditResult(failureReason: string): ApplyWorkspaceEditResult {
  return { applied: false, failureReason };
}

function requestRendererApplyEdit(params: ApplyWorkspaceEditParams): Promise<ApplyWorkspaceEditResult> {
  const requestId = `apply-edit-${nextApplyEditRequestId++}`;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingApplyEditRequests.delete(requestId);
      resolve(fallbackApplyEditResult("Timed out waiting for renderer applyEdit response"));
    }, APPLY_EDIT_RESPONSE_TIMEOUT_MS);
    (timeout as { unref?: () => void }).unref?.();

    pendingApplyEditRequests.set(requestId, { resolve, timeout });
    broadcast("lsp", "applyEdit", { requestId, params });
  });
}

function resolveRendererApplyEdit(
  requestId: string,
  result: ApplyWorkspaceEditResult,
): void {
  const pending = pendingApplyEditRequests.get(requestId);
  if (!pending) return;

  pendingApplyEditRequests.delete(requestId);
  clearTimeout(pending.timeout);
  pending.resolve(result);
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
