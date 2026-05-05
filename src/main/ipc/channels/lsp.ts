// LSP IPC channel — bridges renderer ↔ main ↔ utility(lsp-host).
// Renderer calls are forwarded to the lsp host via the LspHostHandle.
// Utility diagnostics events are broadcast to all renderers.

import { ipcContract } from "../../../shared/ipc-contract";
import type { LspHostHandle } from "../../hosts/lsp-host";
import { broadcast, register, validateArgs } from "../router";

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
        const { uri, version, text } = validateArgs(c.didChange.args, args);
        await lspHost.call("didChange", { uri, version, text });
      },

      didClose: async (args: unknown) => {
        const { uri } = validateArgs(c.didClose.args, args);
        await lspHost.call("didClose", { uri });
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
