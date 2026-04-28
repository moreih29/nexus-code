import { afterEach, describe, expect, test } from "bun:test";

import { LspService } from "../../src/main/lsp/lsp-service";

import {
  StabilityLspSidecarClient,
  cleanupStabilityTempDirs,
  createWorkspaceRegistry,
  languageScenarios,
  protocolRange,
  sequenceFromOne,
  waitFor,
} from "./_fixtures/lsp-stability-fixtures";
import { stableNow } from "./_fixtures/stability-common";

afterEach(async () => {
  await cleanupStabilityTempDirs();
});

describe("LSP capabilities stability integration", () => {
  test("exercises 3 workspaces × 3 harness labels × 3 languages × 9 LSP capabilities with restart/relay/zombie checks", async () => {
    const registry = await createWorkspaceRegistry();
    const sidecarClient = new StabilityLspSidecarClient();
    const service = new LspService({
      workspacePersistenceStore: { getWorkspaceRegistry: async () => registry },
      sidecarClient,
      now: stableNow,
      initializeTimeoutMs: 100,
      shutdownTimeoutMs: 100,
    });

    const matrixResults: string[] = [];
    const recoveryDurationsMs: number[] = [];

    expect(new Set(languageScenarios.map((scenario) => scenario.workspaceId)).size).toBe(3);
    expect(new Set(languageScenarios.map((scenario) => scenario.harness)).size).toBe(3);
    expect(new Set(languageScenarios.map((scenario) => scenario.language)).size).toBe(3);

    for (const scenario of languageScenarios) {
      await service.openDocument({
        type: "lsp-document/open",
        workspaceId: scenario.workspaceId,
        path: scenario.relativePath,
        language: scenario.language,
        content: scenario.content,
        version: 1,
      });

      await expect(
        service.complete({
          type: "lsp-completion/complete",
          workspaceId: scenario.workspaceId,
          path: scenario.relativePath,
          language: scenario.language,
          position: { line: 0, character: 3 },
          triggerKind: "invoked",
          triggerCharacter: null,
        }),
      ).resolves.toMatchObject({ items: [{ label: `${scenario.language}-completion` }] });
      matrixResults.push(`${scenario.language}:completion`);

      await expect(
        service.hover({
          type: "lsp-hover/read",
          workspaceId: scenario.workspaceId,
          path: scenario.relativePath,
          language: scenario.language,
          position: { line: 0, character: 3 },
        }),
      ).resolves.toMatchObject({ contents: [{ value: `${scenario.language} hover 한글` }] });
      matrixResults.push(`${scenario.language}:hover`);

      await expect(
        service.definition({
          type: "lsp-definition/read",
          workspaceId: scenario.workspaceId,
          path: scenario.relativePath,
          language: scenario.language,
          position: { line: 0, character: 3 },
        }),
      ).resolves.toMatchObject({ targets: [{ type: "location-link", targetPath: scenario.relativePath }] });
      matrixResults.push(`${scenario.language}:definition`);

      await expect(
        service.references({
          type: "lsp-references/read",
          workspaceId: scenario.workspaceId,
          path: scenario.relativePath,
          language: scenario.language,
          position: { line: 0, character: 3 },
          includeDeclaration: true,
        }),
      ).resolves.toMatchObject({ locations: [{ path: scenario.relativePath }] });
      matrixResults.push(`${scenario.language}:references`);

      await expect(
        service.prepareRename({
          type: "lsp-rename/prepare",
          workspaceId: scenario.workspaceId,
          path: scenario.relativePath,
          language: scenario.language,
          position: { line: 0, character: 3 },
        }),
      ).resolves.toMatchObject({ canRename: true, placeholder: "value" });
      await expect(
        service.renameSymbol({
          type: "lsp-rename/rename",
          workspaceId: scenario.workspaceId,
          path: scenario.relativePath,
          language: scenario.language,
          position: { line: 0, character: 3 },
          newName: `${scenario.language}_renamed`,
        }),
      ).resolves.toMatchObject({ workspaceEdit: { changes: [{ path: scenario.relativePath }] } });
      matrixResults.push(`${scenario.language}:rename`);

      await expect(
        service.formatDocument({
          type: "lsp-formatting/document",
          workspaceId: scenario.workspaceId,
          path: scenario.relativePath,
          language: scenario.language,
          options: { tabSize: 2, insertSpaces: true },
        }),
      ).resolves.toMatchObject({ edits: [{ newText: `${scenario.language}-formatted` }] });
      await expect(
        service.formatRange({
          type: "lsp-formatting/range",
          workspaceId: scenario.workspaceId,
          path: scenario.relativePath,
          language: scenario.language,
          range: protocolRange(0, 0, 0, 5),
          options: { tabSize: 2, insertSpaces: true },
        }),
      ).resolves.toMatchObject({ edits: [{ newText: `${scenario.language}-range-formatted` }] });
      matrixResults.push(`${scenario.language}:formatting`);

      await expect(
        service.getSignatureHelp({
          type: "lsp-signature-help/get",
          workspaceId: scenario.workspaceId,
          path: scenario.relativePath,
          language: scenario.language,
          position: { line: 0, character: 8 },
          triggerKind: "trigger-character",
          triggerCharacter: "(",
        }),
      ).resolves.toMatchObject({ signatureHelp: { signatures: [{ label: `${scenario.language}Fn(value)` }] } });
      matrixResults.push(`${scenario.language}:signature-help`);

      await expect(
        service.codeActions({
          type: "lsp-code-action/list",
          workspaceId: scenario.workspaceId,
          path: scenario.relativePath,
          language: scenario.language,
          range: protocolRange(0, 0, 0, 5),
          diagnostics: [],
          only: "quickfix",
        }),
      ).resolves.toMatchObject({ actions: [{ title: `${scenario.language} quick fix`, kind: "quickfix" }] });
      matrixResults.push(`${scenario.language}:code-action`);

      await expect(
        service.documentSymbols({
          type: "lsp-document-symbols/read",
          workspaceId: scenario.workspaceId,
          path: scenario.relativePath,
          language: scenario.language,
        }),
      ).resolves.toMatchObject({ symbols: [{ name: `${scenario.language}Symbol`, kind: "function" }] });
      matrixResults.push(`${scenario.language}:document-symbols`);

      const initializeMessages = sidecarClient.startedServers
        .filter((server) => server.command.workspaceId === scenario.workspaceId)
        .flatMap((server) => server.receivedMessages.filter((message) => message.method === "initialize"));
      expect(initializeMessages.length).toBeGreaterThan(0);
      expect(JSON.stringify(initializeMessages[0]?.params ?? {})).not.toContain("inlayHint");

      for (let crashIndex = 0; crashIndex < 3; crashIndex += 1) {
        const startsBeforeCrash = sidecarClient.startCommandsFor(scenario.workspaceId, scenario.language).length;
        const startedAt = Date.now();
        sidecarClient.crashServer(scenario.workspaceId, scenario.language);
        await waitFor(async () => {
          expect(sidecarClient.startCommandsFor(scenario.workspaceId, scenario.language)).toHaveLength(startsBeforeCrash + 1);
          const status = await service.readStatus({
            type: "lsp-status/read",
            workspaceId: scenario.workspaceId,
            languages: [scenario.language],
          });
          expect(status.statuses[0]?.state).toBe("ready");
        }, 5_000);
        recoveryDurationsMs.push(Date.now() - startedAt);
      }

      await expect(
        service.hover({
          type: "lsp-hover/read",
          workspaceId: scenario.workspaceId,
          path: scenario.relativePath,
          language: scenario.language,
          position: { line: 0, character: 3 },
        }),
      ).resolves.toMatchObject({ contents: [{ value: `${scenario.language} hover 한글` }] });
    }

    const maxRecoveryMs = Math.max(...recoveryDurationsMs);
    expect(matrixResults).toHaveLength(27);
    expect(maxRecoveryMs).toBeLessThan(5_000);
    expect(recoveryDurationsMs).toHaveLength(9);
    expect(sidecarClient.droppedClientPayloads).toBe(0);
    expect(sidecarClient.malformedPayloads).toBe(0);
    expect(sidecarClient.relayServerSeqs).toEqual(sequenceFromOne(sidecarClient.relayServerSeqs.length));
    expect(sidecarClient.stopCommands.filter((command) => command.reason === "restart")).toHaveLength(0);
    console.info(
      `lsp-capabilities-stability-metrics ${JSON.stringify({
        matrixResults: matrixResults.length,
        restartCycles: recoveryDurationsMs.length,
        maxRecoveryMs,
        relayDrops: sidecarClient.droppedClientPayloads,
        malformedPayloads: sidecarClient.malformedPayloads,
        relayServerFrames: sidecarClient.relayServerSeqs.length,
      })}`,
    );

    await service.dispose();
    expect(sidecarClient.activeServerCount()).toBe(0);
    expect(sidecarClient.stopAllCommands.at(-1)?.reason).toBe("app-shutdown");
  });
});
