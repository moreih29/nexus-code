import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  EditorBridgeEvent,
  LspLanguage,
} from "../../../../shared/src/contracts/editor/editor-bridge";
import type {
  LspClientPayloadMessage,
  LspServerPayloadMessage,
  LspServerStartedReply,
  LspServerStartFailedReply,
  LspServerStoppedEvent,
  LspStartServerCommand,
  LspStopAllServersCommand,
  LspStopAllServersReply,
  LspStopServerCommand,
} from "../../../../shared/src/contracts/lsp/lsp-sidecar";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import { LspService, type LspSidecarClient } from "./lsp-service";

const tempDirs: string[] = [];
const workspaceId = "ws_lsp" as WorkspaceId;
const now = () => new Date("2026-04-27T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })),
  );
});

describe("LspService", () => {
  test("reports unavailable status when the sidecar cannot start a language server command", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const sidecarClient = new FakeLspSidecarClient({
      startFailure: (command) => ({
        state: "unavailable",
        message: `${command.command} is not available on PATH.`,
      }),
    });
    const service = new LspService({
      workspacePersistenceStore: createWorkspaceStore(workspaceRoot),
      sidecarClient,
      now,
      initializeTimeoutMs: 10,
    });

    const result = await service.readStatus({
      type: "lsp-status/read",
      workspaceId,
      languages: ["typescript"],
    });

    expect(result).toEqual({
      type: "lsp-status/read/result",
      workspaceId,
      statuses: [
        {
          language: "typescript",
          state: "unavailable",
          serverName: "typescript-language-server",
          message: "typescript-language-server is not available on PATH.",
          updatedAt: "2026-04-27T00:00:00.000Z",
        },
      ],
      readAt: "2026-04-27T00:00:00.000Z",
    });
  });

  test("relays stdio JSON-RPC frames through the sidecar and propagates diagnostics by workspace-relative path", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    const sidecarClient = new FakeLspSidecarClient({
      serverBehavior: () => ({
        language: "typescript",
        diagnosticsByMethod: {
          "textDocument/didOpen": "Cannot find name 'missing'.",
          "textDocument/didChange": "Cannot find name 'changedMissing'.",
        },
      }),
    });
    const service = new LspService({
      workspacePersistenceStore: createWorkspaceStore(workspaceRoot),
      sidecarClient,
      now,
      initializeTimeoutMs: 50,
      shutdownTimeoutMs: 50,
    });
    const observedEvents: EditorBridgeEvent[] = [];
    service.onEvent((event) => observedEvents.push(event));
    const absoluteFilePath = path.join(workspaceRoot, "src", "index.ts");
    const expectedUri = pathToFileURL(absoluteFilePath).href;

    const openResult = await service.openDocument({
      type: "lsp-document/open",
      workspaceId,
      path: "src/index.ts",
      language: "typescript",
      content: "const value = missing;\n",
      version: 7,
    });

    expect(openResult.status.state).toBe("ready");
    expect(sidecarClient.startCommands[0]).toMatchObject({
      action: "start_server",
      command: "typescript-language-server",
      args: ["--stdio"],
      cwd: workspaceRoot,
      serverName: "typescript-language-server",
    });
    const server = sidecarClient.startedServers[0];
    expect(server?.rawClientInput()).toContain("Content-Length:");
    expect(server?.receivedMessages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "textDocument/didOpen",
    ]);
    expect(server?.receivedMessages.at(2)?.params).toEqual({
      textDocument: {
        uri: expectedUri,
        languageId: "typescript",
        version: 7,
        text: "const value = missing;\n",
      },
    });

    await waitFor(() => {
      expect(
        observedEvents.some(
          (event) =>
            event.type === "lsp-diagnostics/changed" &&
            event.path === "src/index.ts" &&
            event.diagnostics[0]?.message === "Cannot find name 'missing'.",
        ),
      ).toBe(true);
    });

    await service.changeDocument({
      type: "lsp-document/change",
      workspaceId,
      path: "src/index.ts",
      language: "typescript",
      content: "const value = changedMissing;\n",
      version: 8,
    });

    await waitFor(async () => {
      const diagnostics = await service.readDiagnostics({
        type: "lsp-diagnostics/read",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
      });
      expect(diagnostics.diagnostics).toEqual([
        {
          path: "src/index.ts",
          language: "typescript",
          range: {
            start: { line: 0, character: 14 },
            end: { line: 0, character: 21 },
          },
          severity: "error",
          message: "Cannot find name 'changedMissing'.",
          source: "fake-typescript",
          code: "fake-code",
        },
      ]);
    });

    await service.closeDocument({
      type: "lsp-document/close",
      workspaceId,
      path: "src/index.ts",
      language: "typescript",
    });

    expect(server?.receivedMessages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "textDocument/didOpen",
      "textDocument/didChange",
      "textDocument/didClose",
      "shutdown",
      "exit",
    ]);
    expect(sidecarClient.stopCommands.at(-1)).toMatchObject({
      action: "stop_server",
      reason: "document-close",
    });
  });

  test("propagates diagnostics for TypeScript, Python, and Go through fake sidecar servers", async () => {
    const cases: Array<{
      language: LspLanguage;
      relativePath: string;
      expectedCommand: string;
      expectedArgs: string[];
      diagnosticMessage: string;
    }> = [
      {
        language: "typescript",
        relativePath: "src/index.ts",
        expectedCommand: "typescript-language-server",
        expectedArgs: ["--stdio"],
        diagnosticMessage: "TypeScript diagnostic.",
      },
      {
        language: "python",
        relativePath: "src/main.py",
        expectedCommand: "pyright-langserver",
        expectedArgs: ["--stdio"],
        diagnosticMessage: "Python diagnostic.",
      },
      {
        language: "go",
        relativePath: "src/main.go",
        expectedCommand: "gopls",
        expectedArgs: ["serve"],
        diagnosticMessage: "Go diagnostic.",
      },
    ];

    for (const testCase of cases) {
      const workspaceRoot = await createWorkspaceRoot();
      await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
      const sidecarClient = new FakeLspSidecarClient({
        serverBehavior: () => ({
          language: testCase.language,
          diagnosticsByMethod: {
            "textDocument/didOpen": testCase.diagnosticMessage,
          },
        }),
      });
      const service = new LspService({
        workspacePersistenceStore: createWorkspaceStore(workspaceRoot),
        sidecarClient,
        now,
        initializeTimeoutMs: 50,
        shutdownTimeoutMs: 50,
      });

      await service.openDocument({
        type: "lsp-document/open",
        workspaceId,
        path: testCase.relativePath,
        language: testCase.language,
        content: "content\n",
        version: 1,
      });

      expect(sidecarClient.startCommands[0]).toMatchObject({
        command: testCase.expectedCommand,
        args: testCase.expectedArgs,
        cwd: workspaceRoot,
      });

      await waitFor(async () => {
        const diagnostics = await service.readDiagnostics({
          type: "lsp-diagnostics/read",
          workspaceId,
          path: testCase.relativePath,
          language: testCase.language,
        });
        expect(diagnostics.diagnostics).toEqual([
          {
            path: testCase.relativePath,
            language: testCase.language,
            range: {
              start: { line: 0, character: 14 },
              end: { line: 0, character: 21 },
            },
            severity: "error",
            message: testCase.diagnosticMessage,
            source: `fake-${testCase.language}`,
            code: "fake-code",
          },
        ]);
      });

      await service.closeWorkspace(workspaceId);
      await service.dispose();
    }
  });

  test("requests completions for TypeScript, Python, and Go through fake sidecar servers", async () => {
    const cases: Array<{
      language: LspLanguage;
      relativePath: string;
      expectedLabel: string;
      expectedKind: "function" | "method" | "variable";
    }> = [
      {
        language: "typescript",
        relativePath: "src/index.ts",
        expectedLabel: "typescriptCompletion",
        expectedKind: "function",
      },
      {
        language: "python",
        relativePath: "src/main.py",
        expectedLabel: "python_completion",
        expectedKind: "method",
      },
      {
        language: "go",
        relativePath: "src/main.go",
        expectedLabel: "GoCompletion",
        expectedKind: "variable",
      },
    ];

    for (const testCase of cases) {
      const workspaceRoot = await createWorkspaceRoot();
      await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
      const sidecarClient = new FakeLspSidecarClient({
        serverBehavior: () => ({
          language: testCase.language,
          completionItems: [
            {
              label: testCase.expectedLabel,
              kind:
                testCase.expectedKind === "function"
                  ? 3
                  : testCase.expectedKind === "method"
                    ? 2
                    : 6,
              insertText: `${testCase.expectedLabel}($1)`,
              insertTextFormat: 2,
              additionalTextEdits: [
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 0 },
                  },
                  newText: "// import added by fake server\n",
                },
              ],
            },
          ],
        }),
      });
      const service = new LspService({
        workspacePersistenceStore: createWorkspaceStore(workspaceRoot),
        sidecarClient,
        now,
        initializeTimeoutMs: 50,
        shutdownTimeoutMs: 50,
      });
      const absoluteFilePath = path.join(workspaceRoot, testCase.relativePath);
      const expectedUri = pathToFileURL(absoluteFilePath).href;

      await service.openDocument({
        type: "lsp-document/open",
        workspaceId,
        path: testCase.relativePath,
        language: testCase.language,
        content: "content\n",
        version: 1,
      });

      const result = await service.complete({
        type: "lsp-completion/complete",
        workspaceId,
        path: testCase.relativePath,
        language: testCase.language,
        position: { line: 0, character: 7 },
        triggerKind: "invoked",
      });

      expect(result).toEqual({
        type: "lsp-completion/complete/result",
        workspaceId,
        path: testCase.relativePath,
        language: testCase.language,
        isIncomplete: false,
        completedAt: "2026-04-27T00:00:00.000Z",
        items: [
          {
            label: testCase.expectedLabel,
            kind: testCase.expectedKind,
            detail: null,
            documentation: null,
            sortText: null,
            filterText: null,
            insertText: `${testCase.expectedLabel}($1)`,
            insertTextFormat: "snippet",
            range: null,
            additionalTextEdits: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 0 },
                },
                newText: "// import added by fake server\n",
              },
            ],
            commitCharacters: null,
            preselect: null,
            deprecated: null,
          },
        ],
      });
      const server = sidecarClient.startedServers[0];
      expect(server?.receivedMessages.at(-1)).toMatchObject({
        method: "textDocument/completion",
        params: {
          textDocument: {
            uri: expectedUri,
          },
          position: {
            line: 0,
            character: 7,
          },
          context: {
            triggerKind: 1,
          },
        },
      });

      await service.closeWorkspace(workspaceId);
      await service.dispose();
    }
  });

  test("requests hover, definition, references, and document symbols for TypeScript, Python, and Go through fake sidecar servers", async () => {
    const cases: Array<{
      language: LspLanguage;
      relativePath: string;
      expectedHover: string;
      expectedSymbol: string;
    }> = [
      {
        language: "typescript",
        relativePath: "src/index.ts",
        expectedHover: "TypeScript hover.",
        expectedSymbol: "typescriptSymbol",
      },
      {
        language: "python",
        relativePath: "src/main.py",
        expectedHover: "Python hover.",
        expectedSymbol: "python_symbol",
      },
      {
        language: "go",
        relativePath: "src/main.go",
        expectedHover: "Go hover.",
        expectedSymbol: "GoSymbol",
      },
    ];

    for (const testCase of cases) {
      const workspaceRoot = await createWorkspaceRoot();
      await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
      const absoluteFilePath = path.join(workspaceRoot, testCase.relativePath);
      const expectedUri = pathToFileURL(absoluteFilePath).href;
      const sidecarClient = new FakeLspSidecarClient({
        serverBehavior: () => ({
          language: testCase.language,
          hover: {
            contents: {
              kind: testCase.language === "python" ? "plaintext" : "markdown",
              value: testCase.expectedHover,
            },
            range: protocolRange(0, 0, 0, 7),
          },
          definition: {
            targetUri: expectedUri,
            targetRange: protocolRange(0, 0, 0, 12),
            targetSelectionRange: protocolRange(0, 0, 0, 7),
          },
          references: [
            {
              uri: expectedUri,
              range: protocolRange(0, 2, 0, 9),
            },
          ],
          documentSymbols: [
            {
              name: testCase.expectedSymbol,
              detail: "fake symbol",
              kind: 12,
              range: protocolRange(0, 0, 0, 20),
              selectionRange: protocolRange(0, 0, 0, 7),
              children: [],
            },
          ],
        }),
      });
      const service = new LspService({
        workspacePersistenceStore: createWorkspaceStore(workspaceRoot),
        sidecarClient,
        now,
        initializeTimeoutMs: 50,
        shutdownTimeoutMs: 50,
      });

      await service.openDocument({
        type: "lsp-document/open",
        workspaceId,
        path: testCase.relativePath,
        language: testCase.language,
        content: "content\n",
        version: 1,
      });

      await expect(
        service.hover({
          type: "lsp-hover/read",
          workspaceId,
          path: testCase.relativePath,
          language: testCase.language,
          position: { line: 0, character: 3 },
        }),
      ).resolves.toMatchObject({
        type: "lsp-hover/read/result",
        workspaceId,
        path: testCase.relativePath,
        language: testCase.language,
        contents: [
          {
            kind: testCase.language === "python" ? "plaintext" : "markdown",
            value: testCase.expectedHover,
          },
        ],
      });
      await expect(
        service.definition({
          type: "lsp-definition/read",
          workspaceId,
          path: testCase.relativePath,
          language: testCase.language,
          position: { line: 0, character: 3 },
        }),
      ).resolves.toMatchObject({
        type: "lsp-definition/read/result",
        targets: [
          {
            type: "location-link",
            targetUri: expectedUri,
            targetPath: testCase.relativePath,
          },
        ],
      });
      await expect(
        service.references({
          type: "lsp-references/read",
          workspaceId,
          path: testCase.relativePath,
          language: testCase.language,
          position: { line: 0, character: 3 },
          includeDeclaration: true,
        }),
      ).resolves.toMatchObject({
        type: "lsp-references/read/result",
        locations: [
          {
            uri: expectedUri,
            path: testCase.relativePath,
          },
        ],
      });
      await expect(
        service.documentSymbols({
          type: "lsp-document-symbols/read",
          workspaceId,
          path: testCase.relativePath,
          language: testCase.language,
        }),
      ).resolves.toMatchObject({
        type: "lsp-document-symbols/read/result",
        symbols: [
          {
            type: "document-symbol",
            name: testCase.expectedSymbol,
            kind: "function",
          },
        ],
      });

      const server = sidecarClient.startedServers[0];
      expect(server?.receivedMessages.slice(-4).map((message) => message.method)).toEqual([
        "textDocument/hover",
        "textDocument/definition",
        "textDocument/references",
        "textDocument/documentSymbol",
      ]);
      expect(server?.receivedMessages.at(-2)?.params).toMatchObject({
        context: {
          includeDeclaration: true,
        },
      });

      await service.closeWorkspace(workspaceId);
      await service.dispose();
    }
  });

  test("requests rename, formatting, signature help, and code actions for TypeScript, Python, and Go through fake sidecar servers", async () => {
    const cases: Array<{
      language: LspLanguage;
      relativePath: string;
      renameText: string;
      signatureLabel: string;
      actionTitle: string;
    }> = [
      {
        language: "typescript",
        relativePath: "src/index.ts",
        renameText: "새값",
        signatureLabel: "typescriptFn(value: string): void",
        actionTitle: "TypeScript quick fix",
      },
      {
        language: "python",
        relativePath: "src/main.py",
        renameText: "python_renamed",
        signatureLabel: "python_fn(value: str) -> None",
        actionTitle: "Python quick fix",
      },
      {
        language: "go",
        relativePath: "src/main.go",
        renameText: "GoRenamed",
        signatureLabel: "GoFn(value string)",
        actionTitle: "Go quick fix",
      },
    ];

    for (const testCase of cases) {
      const workspaceRoot = await createWorkspaceRoot();
      await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
      const absoluteFilePath = path.join(workspaceRoot, testCase.relativePath);
      const expectedUri = pathToFileURL(absoluteFilePath).href;
      const sidecarClient = new FakeLspSidecarClient({
        serverBehavior: () => ({
          language: testCase.language,
          prepareRename: {
            range: protocolRange(0, 0, 0, 5),
            placeholder: "value",
          },
          renameEdit: {
            changes: {
              [expectedUri]: [
                {
                  range: protocolRange(0, 0, 0, 5),
                  newText: testCase.renameText,
                },
              ],
            },
          },
          formattingEdits: [
            {
              range: protocolRange(0, 0, 0, 7),
              newText: "formatted",
            },
          ],
          rangeFormattingEdits: [
            {
              range: protocolRange(0, 0, 0, 3),
              newText: "fmt",
            },
          ],
          signatureHelp: {
            signatures: [
              {
                label: testCase.signatureLabel,
                parameters: [{ label: "value" }],
              },
            ],
            activeSignature: 0,
            activeParameter: 0,
          },
          codeActions: [
            {
              title: testCase.actionTitle,
              kind: "quickfix",
              edit: {
                changes: {
                  [expectedUri]: [
                    {
                      range: protocolRange(0, 0, 0, 0),
                      newText: "// fixed\n",
                    },
                  ],
                },
              },
              isPreferred: true,
            },
            {
              title: "Organize Imports",
              command: "source.organizeImports",
              arguments: [testCase.relativePath],
            },
          ],
        }),
      });
      const service = new LspService({
        workspacePersistenceStore: createWorkspaceStore(workspaceRoot),
        sidecarClient,
        now,
        initializeTimeoutMs: 50,
        shutdownTimeoutMs: 50,
      });

      await service.openDocument({
        type: "lsp-document/open",
        workspaceId,
        path: testCase.relativePath,
        language: testCase.language,
        content: "content\n",
        version: 1,
      });

      await expect(
        service.prepareRename({
          type: "lsp-rename/prepare",
          workspaceId,
          path: testCase.relativePath,
          language: testCase.language,
          position: { line: 0, character: 2 },
        }),
      ).resolves.toMatchObject({
        type: "lsp-rename/prepare/result",
        canRename: true,
        placeholder: "value",
      });
      await expect(
        service.renameSymbol({
          type: "lsp-rename/rename",
          workspaceId,
          path: testCase.relativePath,
          language: testCase.language,
          position: { line: 0, character: 2 },
          newName: testCase.renameText,
        }),
      ).resolves.toMatchObject({
        type: "lsp-rename/rename/result",
        workspaceEdit: {
          changes: [
            {
              path: testCase.relativePath,
              edits: [{ newText: testCase.renameText }],
            },
          ],
        },
      });
      await expect(
        service.formatDocument({
          type: "lsp-formatting/document",
          workspaceId,
          path: testCase.relativePath,
          language: testCase.language,
          options: { tabSize: 2, insertSpaces: true },
        }),
      ).resolves.toMatchObject({
        type: "lsp-formatting/document/result",
        edits: [{ newText: "formatted" }],
      });
      await expect(
        service.formatRange({
          type: "lsp-formatting/range",
          workspaceId,
          path: testCase.relativePath,
          language: testCase.language,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
          options: { tabSize: 2, insertSpaces: true },
        }),
      ).resolves.toMatchObject({
        type: "lsp-formatting/range/result",
        edits: [{ newText: "fmt" }],
      });
      await expect(
        service.getSignatureHelp({
          type: "lsp-signature-help/get",
          workspaceId,
          path: testCase.relativePath,
          language: testCase.language,
          position: { line: 0, character: 3 },
          triggerKind: "trigger-character",
          triggerCharacter: "(",
        }),
      ).resolves.toMatchObject({
        type: "lsp-signature-help/get/result",
        signatureHelp: {
          signatures: [{ label: testCase.signatureLabel }],
        },
      });
      await expect(
        service.codeActions({
          type: "lsp-code-action/list",
          workspaceId,
          path: testCase.relativePath,
          language: testCase.language,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } },
          diagnostics: [],
          only: "quickfix",
        }),
      ).resolves.toMatchObject({
        type: "lsp-code-action/list/result",
        actions: [
          {
            title: testCase.actionTitle,
            kind: "quickfix",
            edit: {
              changes: [{ path: testCase.relativePath }],
            },
            isPreferred: true,
          },
          {
            title: "Organize Imports",
            command: {
              command: "source.organizeImports",
            },
          },
        ],
      });

      const server = sidecarClient.startedServers[0];
      expect(server?.receivedMessages.slice(-6).map((message) => message.method)).toEqual([
        "textDocument/prepareRename",
        "textDocument/rename",
        "textDocument/formatting",
        "textDocument/rangeFormatting",
        "textDocument/signatureHelp",
        "textDocument/codeAction",
      ]);
      expect(
        server?.receivedMessages.find((message) => message.method === "textDocument/rename")
          ?.params,
      ).toMatchObject({
        newName: testCase.renameText,
      });

      await service.closeWorkspace(workspaceId);
      await service.dispose();
    }
  });

  test("falls back from `gopls serve` to bare `gopls` when serve exits before initialize", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const sidecarClient = new FakeLspSidecarClient({
      serverBehavior: (command) => ({
        language: "go",
        exitBeforeInitialize: command.args[0] === "serve",
      }),
    });
    const service = new LspService({
      workspacePersistenceStore: createWorkspaceStore(workspaceRoot),
      sidecarClient,
      now,
      initializeTimeoutMs: 50,
    });

    const status = await service.readStatus({
      type: "lsp-status/read",
      workspaceId,
      languages: ["go"],
    });

    expect(sidecarClient.startCommands.map((command) => ({
      command: command.command,
      args: command.args,
    }))).toEqual([
      { command: "gopls", args: ["serve"] },
      { command: "gopls", args: [] },
    ]);
    expect(status.statuses[0]).toMatchObject({
      language: "go",
      state: "ready",
      serverName: "gopls",
    });
  });

  test("automatically restarts a ready sidecar LSP session after an unexpected exit", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const sidecarClient = new FakeLspSidecarClient({
      serverBehavior: () => ({ language: "typescript" }),
    });
    const service = new LspService({
      workspacePersistenceStore: createWorkspaceStore(workspaceRoot),
      sidecarClient,
      now,
      initializeTimeoutMs: 50,
      shutdownTimeoutMs: 50,
    });

    const initialStatus = await service.readStatus({
      type: "lsp-status/read",
      workspaceId,
      languages: ["typescript"],
    });
    expect(initialStatus.statuses[0]?.state).toBe("ready");

    const firstCommand = sidecarClient.startCommands[0];
    if (!firstCommand) {
      throw new Error("Expected initial LSP start command.");
    }
    sidecarClient.emitStopped({
      type: "lsp/lifecycle",
      action: "server_stopped",
      workspaceId: firstCommand.workspaceId,
      serverId: firstCommand.serverId,
      language: firstCommand.language,
      serverName: firstCommand.serverName,
      reason: "restart",
      exitCode: 42,
      signal: null,
      stoppedAt: "2026-04-27T00:00:00.000Z",
    });

    await waitFor(async () => {
      expect(sidecarClient.startCommands).toHaveLength(2);
      const status = await service.readStatus({
        type: "lsp-status/read",
        workspaceId,
        languages: ["typescript"],
      });
      expect(status.statuses[0]).toMatchObject({
        language: "typescript",
        state: "ready",
        serverName: "typescript-language-server",
      });
    });
    expect(sidecarClient.stopCommands).toHaveLength(0);
    expect(sidecarClient.startedServers[1]?.receivedMessages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
    ]);

    await service.dispose();
  });

  test("disposes running language servers on workspace close through sidecar stop_server and stop_all", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const sidecarClient = new FakeLspSidecarClient({
      serverBehavior: () => ({ language: "python" }),
    });
    const service = new LspService({
      workspacePersistenceStore: createWorkspaceStore(workspaceRoot),
      sidecarClient,
      now,
      initializeTimeoutMs: 50,
      shutdownTimeoutMs: 50,
    });
    const observedEvents: EditorBridgeEvent[] = [];
    service.onEvent((event) => observedEvents.push(event));

    await service.openDocument({
      type: "lsp-document/open",
      workspaceId,
      path: "main.py",
      language: "python",
      content: "print('hello')\n",
      version: 1,
    });
    await service.closeWorkspace(workspaceId);

    expect(sidecarClient.startedServers[0]?.receivedMessages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "textDocument/didOpen",
      "shutdown",
      "exit",
    ]);
    expect(sidecarClient.stopCommands.at(-1)).toMatchObject({
      action: "stop_server",
      reason: "workspace-close",
    });
    expect(sidecarClient.stopAllCommands.at(-1)).toMatchObject({
      action: "stop_all",
      reason: "workspace-close",
    });
    expect(
      observedEvents
        .filter((event) => event.type === "lsp-status/changed")
        .at(-1),
    ).toMatchObject({
      type: "lsp-status/changed",
      workspaceId,
      status: {
        language: "python",
        state: "stopped",
      },
    });
    const status = await service.readStatus({
      type: "lsp-status/read",
      workspaceId,
      languages: ["python"],
    });
    expect(status.statuses[0]?.state).toBe("stopped");
    expect(sidecarClient.startedServers).toHaveLength(1);
    await service.dispose();
    expect(sidecarClient.stopAllCommands.at(-1)).toMatchObject({
      action: "stop_all",
      reason: "app-shutdown",
    });
  });
});

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

interface FakeServerBehavior {
  language: LspLanguage;
  diagnosticsByMethod?: Partial<Record<string, string>>;
  completionItems?: unknown[];
  prepareRename?: unknown;
  renameEdit?: unknown;
  formattingEdits?: unknown[];
  rangeFormattingEdits?: unknown[];
  signatureHelp?: unknown;
  codeActions?: unknown[];
  hover?: unknown;
  definition?: unknown;
  references?: unknown[];
  documentSymbols?: unknown[];
  exitBeforeInitialize?: boolean;
}

interface FakeStartFailure {
  state: "unavailable" | "error";
  message: string;
}

class FakeLspSidecarClient implements LspSidecarClient {
  public readonly startCommands: LspStartServerCommand[] = [];
  public readonly stopCommands: LspStopServerCommand[] = [];
  public readonly stopAllCommands: LspStopAllServersCommand[] = [];
  public readonly startedServers: FakeLanguageServerSession[] = [];
  private readonly servers = new Map<string, FakeLanguageServerSession>();
  private readonly payloadListeners = new Set<(message: LspServerPayloadMessage) => void>();
  private readonly stoppedListeners = new Set<(event: LspServerStoppedEvent) => void>();
  private seq = 1;

  public constructor(
    private readonly options: {
      serverBehavior?: (command: LspStartServerCommand) => FakeServerBehavior;
      startFailure?: (command: LspStartServerCommand) => FakeStartFailure | null;
    } = {},
  ) {}

  public async startServer(
    command: LspStartServerCommand,
  ): Promise<LspServerStartedReply | LspServerStartFailedReply> {
    this.startCommands.push(command);
    const failure = this.options.startFailure?.(command);
    if (failure) {
      return {
        type: "lsp/lifecycle",
        action: "server_start_failed",
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        serverId: command.serverId,
        language: command.language,
        serverName: command.serverName,
        state: failure.state,
        message: failure.message,
      };
    }

    const behavior = this.options.serverBehavior?.(command) ?? { language: command.language };
    const server = new FakeLanguageServerSession(this, command, behavior);
    this.servers.set(command.serverId, server);
    this.startedServers.push(server);
    return {
      type: "lsp/lifecycle",
      action: "server_started",
      requestId: command.requestId,
      workspaceId: command.workspaceId,
      serverId: command.serverId,
      language: command.language,
      serverName: command.serverName,
      pid: 5000 + this.startedServers.length,
    };
  }

  public async stopServer(command: LspStopServerCommand): Promise<LspServerStoppedEvent> {
    this.stopCommands.push(command);
    this.servers.delete(command.serverId);
    const event: LspServerStoppedEvent = {
      type: "lsp/lifecycle",
      action: "server_stopped",
      requestId: command.requestId,
      workspaceId: command.workspaceId,
      serverId: command.serverId,
      language: command.language,
      serverName: command.serverName,
      reason: command.reason,
      exitCode: 0,
      signal: null,
      stoppedAt: "2026-04-27T00:00:00.000Z",
    };
    this.emitStopped(event);
    return event;
  }

  public async stopAllServers(command: LspStopAllServersCommand): Promise<LspStopAllServersReply> {
    this.stopAllCommands.push(command);
    const stoppedServerIds = Array.from(this.servers.values())
      .filter((server) => !command.workspaceId || server.command.workspaceId === command.workspaceId)
      .map((server) => server.command.serverId);
    for (const serverId of stoppedServerIds) {
      this.servers.delete(serverId);
    }
    return {
      type: "lsp/lifecycle",
      action: "stop_all_stopped",
      requestId: command.requestId,
      workspaceId: command.workspaceId,
      stoppedServerIds,
    };
  }

  public async stopAllLspServers(reason = "app-shutdown" as const): Promise<void> {
    await this.stopAllServers({
      type: "lsp/lifecycle",
      action: "stop_all",
      requestId: `fake-stop-all-${this.stopAllCommands.length + 1}`,
      workspaceId,
      reason,
    });
  }

  public sendClientPayload(message: LspClientPayloadMessage): void {
    const server = this.servers.get(message.serverId);
    if (!server) {
      return;
    }
    server.receive(message.payload);
  }

  public onServerPayload(listener: (message: LspServerPayloadMessage) => void) {
    this.payloadListeners.add(listener);
    return {
      dispose: () => {
        this.payloadListeners.delete(listener);
      },
    };
  }

  public onServerStopped(listener: (event: LspServerStoppedEvent) => void) {
    this.stoppedListeners.add(listener);
    return {
      dispose: () => {
        this.stoppedListeners.delete(listener);
      },
    };
  }

  public emitServerPayload(command: LspStartServerCommand, payload: string): void {
    const message: LspServerPayloadMessage = {
      type: "lsp/relay",
      direction: "server_to_client",
      workspaceId: command.workspaceId,
      serverId: command.serverId,
      seq: this.seq++,
      payload,
    };
    for (const listener of [...this.payloadListeners]) {
      listener(message);
    }
  }

  public emitStopped(event: LspServerStoppedEvent): void {
    for (const listener of [...this.stoppedListeners]) {
      listener(event);
    }
  }
}

class FakeLanguageServerSession {
  public readonly receivedMessages: JsonRpcMessage[] = [];
  public readonly clientChunks: Buffer[] = [];
  private exitedBeforeInitialize = false;
  private readonly parser = new TestJsonRpcParser((message) => {
    this.receivedMessages.push(message);
    this.handleClientMessage(message);
  });

  public constructor(
    private readonly client: FakeLspSidecarClient,
    public readonly command: LspStartServerCommand,
    private readonly behavior: FakeServerBehavior,
  ) {}

  public receive(payload: string): void {
    const buffer = Buffer.from(payload, "utf8");
    this.clientChunks.push(buffer);
    this.parser.push(buffer);
  }

  public rawClientInput(): string {
    return Buffer.concat(this.clientChunks).toString("utf8");
  }

  private handleClientMessage(message: JsonRpcMessage): void {
    if (message.method === "initialize" && this.behavior.exitBeforeInitialize && !this.exitedBeforeInitialize) {
      this.exitedBeforeInitialize = true;
      this.client.emitStopped({
        type: "lsp/lifecycle",
        action: "server_stopped",
        workspaceId: this.command.workspaceId,
        serverId: this.command.serverId,
        language: this.command.language,
        serverName: this.command.serverName,
        reason: "restart",
        exitCode: 1,
        signal: null,
        stoppedAt: "2026-04-27T00:00:00.000Z",
      });
      return;
    }

    if (message.method === "initialize" && message.id !== undefined) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          capabilities: {
            textDocumentSync: 1,
          },
        },
      });
      return;
    }

    const diagnosticMessage = message.method
      ? this.behavior.diagnosticsByMethod?.[message.method]
      : null;
    if (diagnosticMessage) {
      const textDocument = (message.params?.textDocument ?? {}) as { uri?: string; version?: number };
      this.publishDiagnostics(textDocument.uri, textDocument.version, diagnosticMessage);
      return;
    }

    if (message.method === "textDocument/completion" && message.id !== undefined) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          isIncomplete: false,
          items: this.behavior.completionItems ?? [],
        },
      });
      return;
    }

    if (message.method === "textDocument/hover" && message.id !== undefined) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: this.behavior.hover ?? null,
      });
      return;
    }

    if (message.method === "textDocument/definition" && message.id !== undefined) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: this.behavior.definition ?? null,
      });
      return;
    }

    if (message.method === "textDocument/references" && message.id !== undefined) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: this.behavior.references ?? [],
      });
      return;
    }

    if (message.method === "textDocument/documentSymbol" && message.id !== undefined) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: this.behavior.documentSymbols ?? [],
      });
      return;
    }

    if (message.method === "textDocument/prepareRename" && message.id !== undefined) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: this.behavior.prepareRename ?? {
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 11 },
          },
          placeholder: "value",
        },
      });
      return;
    }

    if (message.method === "textDocument/rename" && message.id !== undefined) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: this.behavior.renameEdit ?? { changes: {} },
      });
      return;
    }

    if (message.method === "textDocument/formatting" && message.id !== undefined) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: this.behavior.formattingEdits ?? [],
      });
      return;
    }

    if (message.method === "textDocument/rangeFormatting" && message.id !== undefined) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: this.behavior.rangeFormattingEdits ?? [],
      });
      return;
    }

    if (message.method === "textDocument/signatureHelp" && message.id !== undefined) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: this.behavior.signatureHelp ?? null,
      });
      return;
    }

    if (message.method === "textDocument/codeAction" && message.id !== undefined) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: this.behavior.codeActions ?? [],
      });
      return;
    }

    if (message.method === "shutdown" && message.id !== undefined) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: null,
      });
    }
  }

  private publishDiagnostics(
    uri: string | undefined,
    version: number | undefined,
    message: string,
  ): void {
    this.send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri,
        version,
        diagnostics: [
          {
            range: {
              start: { line: 0, character: 14 },
              end: { line: 0, character: 21 },
            },
            severity: 1,
            message,
            source: `fake-${this.behavior.language}`,
            code: "fake-code",
          },
        ],
      },
    });
  }

  private send(message: JsonRpcMessage): void {
    this.client.emitServerPayload(this.command, frameJsonRpcMessage(message));
  }
}

class TestJsonRpcParser {
  private buffer = Buffer.alloc(0);

  public constructor(private readonly onMessage: (message: JsonRpcMessage) => void) {}

  public push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const contentLengthMatch = /^Content-Length:\s*(\d+)/im.exec(header);
      if (!contentLengthMatch) {
        throw new Error(`Missing Content-Length header: ${header}`);
      }
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + Number(contentLengthMatch[1]);
      if (this.buffer.length < bodyEnd) {
        return;
      }

      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);
      this.onMessage(JSON.parse(body) as JsonRpcMessage);
    }
  }
}

function frameJsonRpcMessage(message: JsonRpcMessage): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function protocolRange(
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

async function createWorkspaceRoot(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "nexus-lsp-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function createWorkspaceStore(workspaceRoot: string) {
  return {
    async getWorkspaceRegistry() {
      return {
        version: 1 as const,
        workspaces: [
          {
            id: workspaceId,
            absolutePath: workspaceRoot,
            displayName: "LSP Workspace",
            createdAt: "2026-04-27T00:00:00.000Z",
            lastOpenedAt: "2026-04-27T00:00:00.000Z",
          },
        ],
      };
    },
  };
}

async function waitFor(
  assertion: () => void | Promise<void>,
  timeoutMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error("Timed out waiting for assertion.");
}
