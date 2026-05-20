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
    // typescript-language-server (and most LSP servers) gate "multi-root
    // project" / "extended project tracking" logic behind this advertisement.
    // Without it the server falls back to a single-rootUri view with
    // inferred-project defaults — which on monorepo-rooted .tsx files
    // manifests as JSX parsing being silently disabled (the visible
    // symptom: `<Component />` is parsed as a generic instantiation, so
    // "value used as type" + "declared but never read" appear on the
    // import line simultaneously).
    workspaceFolders: true,
    // Server can request workspace/configuration. agent-host already
    // handles the inbound request (server-messages.go path), but servers
    // only emit it when this capability is advertised.
    configuration: true,
    // Server can request workspace/applyEdit (rename / code-action
    // outcomes). The renderer's applyWorkspaceEdit bridges into Monaco.
    applyEdit: true,
    didChangeWatchedFiles: {
      dynamicRegistration: true,
    },
    // workspaceSymbol routing exists in agent-host (call("workspaceSymbol")),
    // but servers gate the workspaceSymbolProvider capability on this entry.
    symbol: {},
  },
  // Server can request window/workDoneProgress/create. agent-host handles
  // it; advertise here so the server emits progress at all.
  window: {
    workDoneProgress: true,
  },
  textDocument: {
    // Static synchronization advertisement. We do not emit willSave /
    // willSaveWaitUntil, so those are explicitly false; didSave is on.
    synchronization: {
      didSave: true,
      willSave: false,
      willSaveWaitUntil: false,
    },
    hover: {
      contentFormat: ["markdown", "plaintext"],
    },
    completion: {
      completionItem: {
        snippetSupport: false,
        documentationFormat: ["markdown", "plaintext"],
        deprecatedSupport: true,
      },
    },
    definition: {
      // We normalize results as Location[], not LocationLink — opt out
      // of linkSupport so servers send the plain shape.
      linkSupport: false,
    },
    references: {},
    documentHighlight: {},
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
