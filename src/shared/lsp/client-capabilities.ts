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
    // Servers (e.g. typescript-language-server 5.x) only emit
    // textDocument/publishDiagnostics when the client advertises support
    // here, so this entry is required for the per-URI debounce in
    // src/main/features/lsp/agent-host.ts to receive any traffic at all.
    publishDiagnostics: {
      relatedInformation: true,
    },
    // Advertise full-document semantic tokens support. Servers gate the
    // semanticTokensProvider capability behind this entry: typescript-
    // language-server, basedpyright, and similar checkers all decline to
    // advertise it when the client legend is missing. Note that upstream
    // microsoft/pyright does NOT implement semantic tokens at all (the
    // feature lives in closed-source Pylance) — we bundle basedpyright,
    // the community fork that ships it under MIT. The tokenTypes /
    // tokenModifiers arrays declare the standard LSP 3.16 legend; servers
    // ignore unknown entries and only use what they understand.
    semanticTokens: {
      requests: {
        full: true,
      },
      tokenTypes: [
        "namespace",
        "type",
        "class",
        "enum",
        "interface",
        "struct",
        "typeParameter",
        "parameter",
        "variable",
        "property",
        "enumMember",
        "event",
        "function",
        "method",
        "macro",
        "keyword",
        "modifier",
        "comment",
        "string",
        "number",
        "regexp",
        "operator",
        "decorator",
        "label",
      ],
      tokenModifiers: [
        "declaration",
        "definition",
        "readonly",
        "static",
        "deprecated",
        "abstract",
        "async",
        "modification",
        "documentation",
        "defaultLibrary",
      ],
      formats: ["relative"],
      multilineTokenSupport: false,
      overlappingTokenSupport: false,
      serverCancelSupport: false,
      augmentsSyntaxTokens: true,
    },
  },
} as const;
