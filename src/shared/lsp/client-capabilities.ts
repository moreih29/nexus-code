// LSP client capabilities advertised in the `initialize` request. This is
// LSP-method-specific knowledge and therefore lives on the Electron side —
// the Go agent stays a transport that only knows JSON-RPC framing, request
// correlation, server lifecycle, and file-watch routing. When you need a
// new server capability (e.g. signatureHelp, semanticTokens) wire it here,
// not in `internal/lsp/`.
//
// The object is sent verbatim to the Go agent via `lsp.spawn` and forwarded
// into the LSP server's `initialize` params under the `capabilities` key.

export const LSP_CLIENT_CAPABILITIES = {
  workspace: {
    didChangeWatchedFiles: {
      dynamicRegistration: true,
    },
  },
  textDocument: {
    documentSymbol: {
      hierarchicalDocumentSymbolSupport: true,
    },
  },
} as const;
