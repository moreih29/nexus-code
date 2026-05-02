// LSP IPC channel — bridges renderer ↔ main ↔ utility(lsp-host).
// Renderer calls are forwarded to the lsp host via the LspHostHandle.
// Utility diagnostics events are broadcast to all renderers.

import { ipcContract } from "../../../shared/ipc-contract";
import { register, validateArgs, broadcast } from "../router";
import type { LspHostHandle } from "../../hosts/lspHost";

const c = ipcContract.lsp.call;

export function registerLspChannel(lspHost: LspHostHandle): void {
  // Forward utility→main diagnostics events to renderers
  lspHost.on("diagnostics", (args) => {
    const { uri, diagnostics } = args as { uri: string; diagnostics: unknown[] };
    broadcast("lsp", "diagnostics", { uri, diagnostics });
  });

  register("lsp", {
    call: {
      didOpen: async (args: unknown) => {
        const { workspaceId, uri, languageId, version, text } = validateArgs(c.didOpen.args, args);
        await lspHost.call("didOpen", { workspaceId, uri, languageId, version, text });
      },

      didChange: async (args: unknown) => {
        const { uri, version, text } = validateArgs(c.didChange.args, args);
        await lspHost.call("didChange", { uri, version, text });
      },

      hover: async (args: unknown) => {
        const { uri, line, character } = validateArgs(c.hover.args, args);
        const result = await lspHost.call("hover", { uri, line, character });
        return result as { contents: string } | null;
      },

      definition: async (args: unknown) => {
        const { uri, line, character } = validateArgs(c.definition.args, args);
        const result = await lspHost.call("definition", { uri, line, character });
        return result as Array<{ uri: string; line: number; character: number }>;
      },

      completion: async (args: unknown) => {
        const { uri, line, character } = validateArgs(c.completion.args, args);
        const result = await lspHost.call("completion", { uri, line, character });
        return result as Array<{ label: string; kind?: number }>;
      },
    },
    listen: {
      diagnostics: {},
    },
  });
}
