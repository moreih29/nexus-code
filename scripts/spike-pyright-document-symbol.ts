#!/usr/bin/env bun

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { absolutePathToFileUri } from "../src/shared/file-uri";
import {
  type DocumentSymbol,
  DocumentSymbolSchema,
  SymbolInformationSchema,
} from "../src/shared/lsp-types";

type JsonRpcId = number | string | null;

type CapabilityMode = "with-capability" | "without-capability";

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponseEnvelope {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

interface PendingRequest {
  method: string;
  resolve: (response: JsonRpcResponseEnvelope) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface CapturePaths {
  repoRoot: string;
  pyrightBin: string;
  sampleDir: string;
  sampleFile: string;
  outputFile: string;
}

interface CaptureResult {
  pyrightVersion: string;
  capabilityMode: CapabilityMode;
  capturedAt: string;
  command: string[];
  workspaceRoot: string;
  textDocument: {
    uri: string;
    languageId: "python";
  };
  request: {
    method: "textDocument/documentSymbol";
    params: {
      textDocument: {
        uri: string;
      };
    };
  };
  response: JsonRpcResponseEnvelope;
  checks: ReturnType<typeof checkDocumentSymbolResponse>;
}

const REQUEST_TIMEOUT_MS = 15_000;
const DID_OPEN_SETTLE_MS = 250;
const DOCUMENT_SYMBOL_ARRAY_SCHEMA = z.array(DocumentSymbolSchema);
const SYMBOL_INFORMATION_ARRAY_SCHEMA = z.array(SymbolInformationSchema);
const PYRIGHT_INITIALIZATION_OPTIONS = {
  "python.analysis.typeCheckingMode": "standard",
  "python.analysis.diagnosticMode": "openFilesOnly",
  "python.analysis.autoImportCompletions": true,
  "python.analysis.useLibraryCodeForTypes": true,
};
const PYRIGHT_SAMPLE = `class Greeter:
    def greet(self, name: str) -> str:
        return f"Hello, {name}!"


def make_greeter() -> Greeter:
    return Greeter()
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function encodeMessage(message: unknown): Buffer {
  const body = JSON.stringify(message);
  const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, "ascii"), Buffer.from(body, "utf8")]);
}

function parseJsonRpcId(value: unknown): JsonRpcId | undefined {
  if (typeof value === "number" || typeof value === "string" || value === null) return value;
  return undefined;
}

function parseResponseEnvelope(message: Record<string, unknown>): JsonRpcResponseEnvelope | null {
  if (message.jsonrpc !== "2.0") return null;
  if (!("id" in message)) return null;
  if (!("result" in message) && !("error" in message)) return null;

  const id = parseJsonRpcId(message.id);
  if (id === undefined) return null;

  const response: JsonRpcResponseEnvelope = { jsonrpc: "2.0", id };
  if ("result" in message) response.result = message.result;
  if (isRecord(message.error)) {
    const code = typeof message.error.code === "number" ? message.error.code : -32603;
    const errorMessage =
      typeof message.error.message === "string" ? message.error.message : "JSON-RPC error";
    response.error = { code, message: errorMessage, data: message.error.data };
  }
  return response;
}

function lspSettingsForSection(section: string | undefined): unknown {
  const settings = {
    pyright: {
      disableLanguageServices: false,
      disableOrganizeImports: false,
    },
    python: {
      analysis: {
        typeCheckingMode: "standard",
        diagnosticMode: "openFilesOnly",
        autoImportCompletions: true,
        useLibraryCodeForTypes: true,
      },
    },
  };

  if (section === undefined || section.length === 0) return settings;
  if (section === "pyright") return settings.pyright;
  if (section === "python") return settings.python;
  if (section === "python.analysis") return settings.python.analysis;
  if (section.startsWith("python.analysis.")) {
    const key = section.slice("python.analysis.".length);
    return settings.python.analysis[key as keyof typeof settings.python.analysis] ?? null;
  }
  return null;
}

class JsonRpcStdioClient {
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private exited = false;

  constructor(
    private readonly proc: ChildProcessWithoutNullStreams,
    private readonly workspaceFolder: { uri: string; name: string },
  ) {
    this.proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[pyright stderr] ${chunk.toString("utf8")}`);
    });
    this.proc.on("exit", (code, signal) => {
      this.exited = true;
      const error = new Error(
        `pyright-langserver exited before response (code=${code}, signal=${signal})`,
      );
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(error);
        this.pending.delete(id);
      }
    });
    this.proc.on("error", (error) => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(error);
        this.pending.delete(id);
      }
    });
  }

  requestEnvelope(method: string, params: unknown): Promise<JsonRpcResponseEnvelope> {
    if (this.exited) return Promise.reject(new Error("pyright-langserver has exited"));

    const id = this.nextId;
    this.nextId += 1;
    const message = { jsonrpc: "2.0", id, method, params };

    return new Promise<JsonRpcResponseEnvelope>((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`${method} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        method,
        resolve: resolveRequest,
        reject: rejectRequest,
        timeout,
      });
      this.send(message);
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async shutdown(): Promise<void> {
    if (this.exited) return;
    try {
      const response = await this.requestEnvelope("shutdown", null);
      if (response.error) throw new Error(response.error.message);
      this.notify("exit", null);
      await sleep(100);
    } catch {
      this.proc.kill("SIGTERM");
    }
  }

  forceDispose(): void {
    if (this.exited) return;
    this.proc.kill("SIGKILL");
  }

  private send(message: unknown): void {
    if (!this.proc.stdin.writable) throw new Error("pyright-langserver stdin is not writable");
    this.proc.stdin.write(encodeMessage(message));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.parseMessages();
  }

  private parseMessages(): void {
    while (true) {
      const separatorIndex = this.buffer.indexOf("\r\n\r\n");
      if (separatorIndex === -1) return;

      const header = this.buffer.slice(0, separatorIndex).toString("ascii");
      const contentLengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
      if (!contentLengthMatch) {
        this.buffer = this.buffer.slice(separatorIndex + 4);
        continue;
      }

      const contentLength = Number.parseInt(contentLengthMatch[1], 10);
      const bodyStart = separatorIndex + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.buffer.length < bodyEnd) return;

      const body = this.buffer.slice(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.slice(bodyEnd);

      const parsed: unknown = JSON.parse(body);
      this.handleMessage(parsed);
    }
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message)) return;

    const response = parseResponseEnvelope(message);
    if (response) {
      const pending = this.pending.get(response.id);
      if (!pending) return;

      this.pending.delete(response.id);
      clearTimeout(pending.timeout);
      if (response.error) {
        pending.reject(new Error(`${pending.method} failed: ${response.error.message}`));
        return;
      }
      pending.resolve(response);
      return;
    }

    if (typeof message.method !== "string") return;
    const id = parseJsonRpcId(message.id);
    if (id === undefined) return;

    this.handleServerRequest(id, message.method, message.params);
  }

  private handleServerRequest(id: JsonRpcId, method: string, params: unknown): void {
    if (method === "workspace/configuration") {
      const items = isRecord(params) && Array.isArray(params.items) ? params.items : [];
      const result = items.map((item) => {
        const section =
          isRecord(item) && typeof item.section === "string" ? item.section : undefined;
        return lspSettingsForSection(section);
      });
      this.sendResponse(id, result);
      return;
    }

    if (method === "workspace/workspaceFolders") {
      this.sendResponse(id, [this.workspaceFolder]);
      return;
    }

    if (
      method === "client/registerCapability" ||
      method === "client/unregisterCapability" ||
      method === "window/workDoneProgress/create" ||
      method === "window/showMessageRequest"
    ) {
      this.sendResponse(id, null);
      return;
    }

    this.send({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`,
      },
    });
  }

  private sendResponse(id: JsonRpcId, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }
}

function buildPaths(): CapturePaths {
  const repoRoot = resolve(import.meta.dir, "..");
  const pyrightBin = resolve(repoRoot, "node_modules/.bin/pyright-langserver");
  const sampleDir = resolve(repoRoot, "tests/fixtures/lsp/pyright/seed/sample");
  const sampleFile = resolve(sampleDir, "module_a.py");
  const outputFile = resolve(repoRoot, "tests/fixtures/lsp/pyright/seed");
  return { repoRoot, pyrightBin, sampleDir, sampleFile, outputFile };
}

function ensureSampleFile(sampleFile: string): void {
  mkdirSync(dirname(sampleFile), { recursive: true });
  if (!existsSync(sampleFile)) writeFileSync(sampleFile, PYRIGHT_SAMPLE, "utf8");
}

function readPyrightVersion(repoRoot: string): string {
  const packageJsonPath = resolve(repoRoot, "node_modules/pyright/package.json");
  const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (isRecord(parsed) && typeof parsed.version === "string") return parsed.version;
  throw new Error(`Could not read pyright version from ${packageJsonPath}`);
}

function buildInitializeParams(mode: CapabilityMode, workspaceRootUri: string): unknown {
  const documentSymbolCapability =
    mode === "with-capability"
      ? {
          dynamicRegistration: false,
          hierarchicalDocumentSymbolSupport: true,
          symbolKind: { valueSet: Array.from({ length: 26 }, (_unused, index) => index + 1) },
          tagSupport: { valueSet: [1] },
        }
      : {
          dynamicRegistration: false,
          symbolKind: { valueSet: Array.from({ length: 26 }, (_unused, index) => index + 1) },
          tagSupport: { valueSet: [1] },
        };

  return {
    processId: null,
    rootUri: workspaceRootUri,
    workspaceFolders: [
      {
        uri: workspaceRootUri,
        name: "pyright-document-symbol-seed",
      },
    ],
    capabilities: {
      window: {
        workDoneProgress: true,
        showMessage: {
          messageActionItem: {
            additionalPropertiesSupport: true,
          },
        },
      },
      textDocument: {
        synchronization: {
          dynamicRegistration: false,
          willSave: false,
          willSaveWaitUntil: false,
          didSave: true,
        },
        hover: { dynamicRegistration: false, contentFormat: ["plaintext", "markdown"] },
        definition: { dynamicRegistration: false },
        completion: {
          dynamicRegistration: false,
          completionItem: { snippetSupport: false },
        },
        documentSymbol: documentSymbolCapability,
        publishDiagnostics: {
          tagSupport: { valueSet: [1, 2] },
        },
      },
      workspace: {
        configuration: true,
        didChangeWatchedFiles: { dynamicRegistration: true },
      },
    },
    initializationOptions: PYRIGHT_INITIALIZATION_OPTIONS,
  };
}

function hasChildDocumentSymbol(symbols: readonly DocumentSymbol[]): boolean {
  return symbols.some((symbol) => {
    if (symbol.children && symbol.children.length > 0) return true;
    return symbol.children ? hasChildDocumentSymbol(symbol.children) : false;
  });
}

function checkDocumentSymbolResponse(response: JsonRpcResponseEnvelope) {
  const result = response.result;
  const documentSymbolParse = DOCUMENT_SYMBOL_ARRAY_SCHEMA.safeParse(result);
  const symbolInformationParse = SYMBOL_INFORMATION_ARRAY_SCHEMA.safeParse(result);

  return {
    resultIsArray: Array.isArray(result),
    documentSymbolSchemaArray: { success: documentSymbolParse.success },
    documentSymbolArrayHasChildren: documentSymbolParse.success
      ? hasChildDocumentSymbol(documentSymbolParse.data)
      : false,
    symbolInformationSchemaArray: { success: symbolInformationParse.success },
    symbolInformationArrayEveryItemHasLocation: symbolInformationParse.success
      ? symbolInformationParse.data.every((item) => !!item.location)
      : false,
  };
}

function assertCapture(
  mode: CapabilityMode,
  checks: ReturnType<typeof checkDocumentSymbolResponse>,
): void {
  if (mode === "with-capability") {
    if (!checks.documentSymbolSchemaArray.success) {
      throw new Error("Expected DocumentSymbol[] when hierarchicalDocumentSymbolSupport=true");
    }
    if (!checks.documentSymbolArrayHasChildren) {
      throw new Error("Expected hierarchical DocumentSymbol[] with at least one child symbol");
    }
    return;
  }

  if (!checks.symbolInformationSchemaArray.success) {
    throw new Error(
      "Expected SymbolInformation[] when hierarchicalDocumentSymbolSupport is omitted",
    );
  }
  if (!checks.symbolInformationArrayEveryItemHasLocation) {
    throw new Error("Expected every SymbolInformation item to include location");
  }
}

async function capture(mode: CapabilityMode, paths: CapturePaths): Promise<CaptureResult> {
  const pyrightVersion = readPyrightVersion(paths.repoRoot);
  const workspaceRootUri = absolutePathToFileUri(paths.sampleDir);
  const fileUri = absolutePathToFileUri(paths.sampleFile);
  const command = [paths.pyrightBin, "--stdio"];
  const proc = spawn(paths.pyrightBin, ["--stdio"], {
    cwd: paths.repoRoot,
    stdio: "pipe",
    env: { ...process.env },
  });
  const client = new JsonRpcStdioClient(proc, {
    uri: workspaceRootUri,
    name: "pyright-document-symbol-seed",
  });

  try {
    const initializeParams = buildInitializeParams(mode, workspaceRootUri);
    await client.requestEnvelope("initialize", initializeParams);
    client.notify("initialized", {});

    const text = readFileSync(paths.sampleFile, "utf8");
    client.notify("textDocument/didOpen", {
      textDocument: {
        uri: fileUri,
        languageId: "python",
        version: 1,
        text,
      },
    });
    await sleep(DID_OPEN_SETTLE_MS);

    const documentSymbolRequest = {
      method: "textDocument/documentSymbol" as const,
      params: {
        textDocument: { uri: fileUri },
      },
    };
    const response = await client.requestEnvelope(
      documentSymbolRequest.method,
      documentSymbolRequest.params,
    );
    const checks = checkDocumentSymbolResponse(response);
    assertCapture(mode, checks);

    return {
      pyrightVersion,
      capabilityMode: mode,
      capturedAt: new Date().toISOString(),
      command,
      workspaceRoot: workspaceRootUri,
      textDocument: {
        uri: fileUri,
        languageId: "python",
      },
      request: documentSymbolRequest,
      response,
      checks,
    };
  } finally {
    await client.shutdown();
    client.forceDispose();
  }
}

function outputPathForMode(seedDir: string, mode: CapabilityMode): string {
  const name =
    mode === "with-capability"
      ? "document-symbol-with-capability.json"
      : "document-symbol-without-capability.json";
  return resolve(seedDir, name);
}

function writeFixture(seedDir: string, captureResult: CaptureResult): void {
  mkdirSync(seedDir, { recursive: true });
  writeFileSync(
    outputPathForMode(seedDir, captureResult.capabilityMode),
    `${JSON.stringify(captureResult, null, 2)}\n`,
    "utf8",
  );
}

async function main(): Promise<void> {
  const paths = buildPaths();
  ensureSampleFile(paths.sampleFile);

  const withCapability = await capture("with-capability", paths);
  writeFixture(paths.outputFile, withCapability);

  const withoutCapability = await capture("without-capability", paths);
  writeFixture(paths.outputFile, withoutCapability);

  const hierarchicalOnlyAssumption =
    withCapability.checks.documentSymbolSchemaArray.success &&
    withCapability.checks.documentSymbolArrayHasChildren &&
    withoutCapability.checks.symbolInformationSchemaArray.success;

  console.log(`pyrightVersion=${withCapability.pyrightVersion}`);
  console.log(`command=${withCapability.command.join(" ")}`);
  console.log(`with-capability DocumentSymbolSchema[]=PASS`);
  console.log(
    `with-capability has children=${withCapability.checks.documentSymbolArrayHasChildren}`,
  );
  console.log(`without-capability SymbolInformation[]=PASS`);
  console.log(`hierarchical-only assumption=${hierarchicalOnlyAssumption ? "YES" : "NO"}`);
  console.log(`wrote ${outputPathForMode(paths.outputFile, "with-capability")}`);
  console.log(`wrote ${outputPathForMode(paths.outputFile, "without-capability")}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`spike failed: ${message}`);
  process.exit(1);
});
