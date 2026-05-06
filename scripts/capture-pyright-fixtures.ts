#!/usr/bin/env bun

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { absolutePathToFileUri } from "../src/shared/file-uri";
import {
  CompletionItemSchema,
  DocumentHighlightSchema,
  type DocumentSymbol,
  DocumentSymbolSchema,
  HoverResultSchema,
  LocationLinkSchema,
  LocationSchema,
  SymbolInformationSchema,
} from "../src/shared/lsp-types";

type JsonRpcId = number | string | null;

type FixtureName =
  | "references-module_a-class"
  | "references-module_b-cross-file"
  | "document-symbol-module_a"
  | "document-highlight-module_a-readwrite"
  | "workspace-symbol-greet"
  | "hover-module_a-greet"
  | "definition-module_b-greeter"
  | "completion-module_a-context";

type FixtureFileName = `${FixtureName}.json`;

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
  responsesDir: string;
}

interface FixtureTextDocument {
  fileName: "module_a.py" | "module_b.py" | "broken.py";
  uri: string;
  text: string;
}

interface FixtureScenario {
  name: FixtureName;
  method:
    | "textDocument/hover"
    | "textDocument/definition"
    | "textDocument/completion"
    | "textDocument/references"
    | "textDocument/documentSymbol"
    | "textDocument/documentHighlight"
    | "workspace/symbol";
  params: (documents: FixtureTextDocument[]) => unknown;
  assertResponse: (response: JsonRpcResponseEnvelope, workspacePlaceholderUri: string) => void;
}

export interface PyrightFixtureSnapshot {
  pyrightVersion: string;
  workspaceRoot: string;
  request: {
    method: FixtureScenario["method"];
    params: unknown;
  };
  response: JsonRpcResponseEnvelope;
}

const REQUEST_TIMEOUT_MS = 15_000;
const DID_OPEN_SETTLE_MS = 750;
const EXPECTED_PYRIGHT_VERSION = "1.1.409";
const WORKSPACE_PLACEHOLDER_URI = "file:///__PYRIGHT_FIXTURE_WORKSPACE__";
const PYRIGHT_INITIALIZATION_OPTIONS = {
  "python.analysis.typeCheckingMode": "standard",
  "python.analysis.diagnosticMode": "openFilesOnly",
  "python.analysis.autoImportCompletions": true,
  "python.analysis.useLibraryCodeForTypes": true,
};

const SAMPLE_FILES = {
  "module_a.py": `from __future__ import annotations


class Greeter:
    def __init__(self, prefix: str = "Hello") -> None:
        self.prefix = prefix

    def greet(self, name: str) -> str:
        return format_greeting(self.prefix, name)


def format_greeting(prefix: str, name: str) -> str:
    return f"{prefix}, {name}!"


def make_greeter() -> Greeter:
    greeter = Greeter()
    return greeter


def update_counter() -> int:
    counter = 0
    counter = counter + 1
    return counter
`,
  "module_b.py": `from module_a import Greeter, make_greeter


def greet_user(name: str) -> str:
    greeter = make_greeter()
    return greeter.greet(name)


class FriendlyGreeter(Greeter):
    def welcome(self) -> str:
        return self.greet("friend")
`,
  "broken.py": `def broken() -> None:
    print("missing close"
`,
} as const;

const LOCATION_ARRAY_SCHEMA = z.array(LocationSchema);
const DEFINITION_RESULT_SCHEMA = z
  .union([LocationSchema, LocationLinkSchema])
  .array()
  .or(LocationSchema)
  .or(LocationLinkSchema)
  .nullable();
const DOCUMENT_HIGHLIGHT_ARRAY_SCHEMA = z.array(DocumentHighlightSchema);
const DOCUMENT_SYMBOL_ARRAY_SCHEMA = z.array(DocumentSymbolSchema);
const SYMBOL_INFORMATION_ARRAY_SCHEMA = z.array(SymbolInformationSchema);
const CAPTURE_COMPLETION_ITEM_SCHEMA = CompletionItemSchema.passthrough();
const CAPTURE_COMPLETION_RESULT_SCHEMA = z.array(CAPTURE_COMPLETION_ITEM_SCHEMA).or(
  z
    .object({
      isIncomplete: z.boolean(),
      items: z.array(CAPTURE_COMPLETION_ITEM_SCHEMA),
    })
    .passthrough(),
);

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

export function buildPyrightFixturePaths(): CapturePaths {
  const repoRoot = resolve(import.meta.dir, "..");
  const pyrightBin = resolve(repoRoot, "node_modules/.bin/pyright-langserver");
  const sampleDir = resolve(repoRoot, "tests/fixtures/lsp/pyright/sample");
  const responsesDir = resolve(repoRoot, "tests/fixtures/lsp/pyright/responses");
  return { repoRoot, pyrightBin, sampleDir, responsesDir };
}

export function ensurePyrightSampleFiles(paths = buildPyrightFixturePaths()): void {
  mkdirSync(paths.sampleDir, { recursive: true });
  for (const [fileName, text] of Object.entries(SAMPLE_FILES)) {
    writeFileSync(resolve(paths.sampleDir, fileName), text, "utf8");
  }
}

function readPyrightVersion(repoRoot: string): string {
  const packageJsonPath = resolve(repoRoot, "node_modules/pyright/package.json");
  const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (isRecord(parsed) && typeof parsed.version === "string") return parsed.version;
  throw new Error(`Could not read pyright version from ${packageJsonPath}`);
}

function assertExpectedPyrightVersion(version: string): void {
  if (version !== EXPECTED_PYRIGHT_VERSION) {
    throw new Error(`Expected pyright ${EXPECTED_PYRIGHT_VERSION}, got ${version}`);
  }
}

function buildInitializeParams(workspaceRootUri: string): unknown {
  return {
    processId: null,
    rootUri: workspaceRootUri,
    workspaceFolders: [
      {
        uri: workspaceRootUri,
        name: "pyright-fixture-workspace",
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
        references: { dynamicRegistration: false },
        documentHighlight: { dynamicRegistration: false },
        documentSymbol: {
          dynamicRegistration: false,
          hierarchicalDocumentSymbolSupport: true,
          symbolKind: { valueSet: Array.from({ length: 26 }, (_unused, index) => index + 1) },
          tagSupport: { valueSet: [1] },
        },
        completion: {
          dynamicRegistration: false,
          completionItem: { snippetSupport: false },
        },
        publishDiagnostics: {
          tagSupport: { valueSet: [1, 2] },
        },
      },
      workspace: {
        configuration: true,
        workspaceFolders: true,
        didChangeWatchedFiles: { dynamicRegistration: true },
        symbol: { dynamicRegistration: false },
      },
    },
    initializationOptions: PYRIGHT_INITIALIZATION_OPTIONS,
  };
}

function fileUriFor(paths: CapturePaths, fileName: keyof typeof SAMPLE_FILES): string {
  return absolutePathToFileUri(resolve(paths.sampleDir, fileName));
}

function fixtureDocuments(paths: CapturePaths): FixtureTextDocument[] {
  return (Object.keys(SAMPLE_FILES) as Array<keyof typeof SAMPLE_FILES>).map((fileName) => ({
    fileName,
    uri: fileUriFor(paths, fileName),
    text: readFileSync(resolve(paths.sampleDir, fileName), "utf8"),
  }));
}

function documentByName(
  documents: FixtureTextDocument[],
  fileName: FixtureTextDocument["fileName"],
): FixtureTextDocument {
  const document = documents.find((item) => item.fileName === fileName);
  if (!document) throw new Error(`Missing fixture document ${fileName}`);
  return document;
}

function positionInText(
  text: string,
  anchor: string,
  target = anchor,
): { line: number; character: number } {
  const anchorIndex = text.indexOf(anchor);
  if (anchorIndex === -1) throw new Error(`Could not find anchor ${JSON.stringify(anchor)}`);
  const targetIndexWithinAnchor = anchor.indexOf(target);
  if (targetIndexWithinAnchor === -1)
    throw new Error(`Could not find target ${JSON.stringify(target)}`);

  const index = anchorIndex + targetIndexWithinAnchor + Math.floor(target.length / 2);
  const prefix = text.slice(0, index);
  const lines = prefix.split("\n");
  return {
    line: lines.length - 1,
    character: lines[lines.length - 1].length,
  };
}

function positionAfterText(
  text: string,
  anchor: string,
  target = anchor,
): { line: number; character: number } {
  const anchorIndex = text.indexOf(anchor);
  if (anchorIndex === -1) throw new Error(`Could not find anchor ${JSON.stringify(anchor)}`);
  const targetIndexWithinAnchor = anchor.indexOf(target);
  if (targetIndexWithinAnchor === -1)
    throw new Error(`Could not find target ${JSON.stringify(target)}`);

  const index = anchorIndex + targetIndexWithinAnchor + target.length;
  const prefix = text.slice(0, index);
  const lines = prefix.split("\n");
  return {
    line: lines.length - 1,
    character: lines[lines.length - 1].length,
  };
}

function responseResult(response: JsonRpcResponseEnvelope): unknown {
  if (response.error) throw new Error(`Fixture response has error: ${response.error.message}`);
  return response.result;
}

function hasChildDocumentSymbol(symbols: readonly DocumentSymbol[]): boolean {
  return symbols.some((symbol) => {
    if (symbol.children && symbol.children.length > 0) return true;
    return symbol.children ? hasChildDocumentSymbol(symbol.children) : false;
  });
}

function normalizedUriForFile(workspacePlaceholderUri: string, fileName: string): string {
  return `${workspacePlaceholderUri}/${fileName}`;
}

function assertHoverResponse(response: JsonRpcResponseEnvelope): void {
  const parsed = HoverResultSchema.parse(responseResult(response));
  const contents = typeof parsed.contents === "string" ? parsed.contents : parsed.contents.value;
  if (!contents.toLowerCase().includes("greet")) {
    throw new Error("Expected hover fixture to include greet symbol contents");
  }
}

function definitionResultLocations(response: JsonRpcResponseEnvelope): Array<{ uri: string }> {
  const parsed = DEFINITION_RESULT_SCHEMA.parse(responseResult(response));
  if (parsed === null) return [];

  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.map((item) => {
    if ("uri" in item) return { uri: item.uri };
    return { uri: item.targetUri };
  });
}

function assertDefinitionIncludesFile(
  response: JsonRpcResponseEnvelope,
  workspacePlaceholderUri: string,
  fileName: string,
): void {
  const uri = normalizedUriForFile(workspacePlaceholderUri, fileName);
  const locations = definitionResultLocations(response);
  if (!locations.some((location) => location.uri === uri)) {
    throw new Error(`Expected definition locations to include ${uri}`);
  }
}

function assertLocationsIncludeFiles(
  response: JsonRpcResponseEnvelope,
  workspacePlaceholderUri: string,
  fileNames: string[],
): void {
  const parsed = LOCATION_ARRAY_SCHEMA.parse(responseResult(response));
  for (const fileName of fileNames) {
    const uri = normalizedUriForFile(workspacePlaceholderUri, fileName);
    if (!parsed.some((location) => location.uri === uri)) {
      throw new Error(`Expected reference locations to include ${uri}`);
    }
  }
}

function assertDocumentSymbolResponse(response: JsonRpcResponseEnvelope): void {
  const parsed = DOCUMENT_SYMBOL_ARRAY_SCHEMA.parse(responseResult(response));
  if (!hasChildDocumentSymbol(parsed)) {
    throw new Error("Expected documentSymbol fixture to include hierarchical children");
  }
}

function assertDocumentHighlightResponse(response: JsonRpcResponseEnvelope): void {
  const parsed = DOCUMENT_HIGHLIGHT_ARRAY_SCHEMA.parse(responseResult(response));
  const kinds = new Set(parsed.map((highlight) => highlight.kind));
  if (!kinds.has(2) || !kinds.has(3)) {
    throw new Error("Expected documentHighlight fixture to include read and write highlights");
  }
}

function assertWorkspaceSymbolResponse(response: JsonRpcResponseEnvelope): void {
  const parsed = SYMBOL_INFORMATION_ARRAY_SCHEMA.parse(responseResult(response));
  if (parsed.length === 0) throw new Error("Expected workspace/symbol fixture to be non-empty");
  if (!parsed.some((symbol) => symbol.name.toLowerCase().includes("greet"))) {
    throw new Error("Expected workspace/symbol fixture to include greet-related symbols");
  }
}

function assertCompletionResponse(response: JsonRpcResponseEnvelope): void {
  const parsed = CAPTURE_COMPLETION_RESULT_SCHEMA.parse(responseResult(response));
  const items = Array.isArray(parsed) ? parsed : parsed.items;
  if (items.length === 0) throw new Error("Expected completion fixture to be non-empty");
  if (!items.some((item) => item.label === "prefix")) {
    throw new Error("Expected completion fixture to include the class context prefix item");
  }
}

function scenarios(): FixtureScenario[] {
  return [
    {
      name: "hover-module_a-greet",
      method: "textDocument/hover",
      params: (documents) => {
        const moduleA = documentByName(documents, "module_a.py");
        return {
          textDocument: { uri: moduleA.uri },
          position: positionInText(moduleA.text, "    def greet(self, name: str) -> str:", "greet"),
        };
      },
      assertResponse: assertHoverResponse,
    },
    {
      name: "definition-module_b-greeter",
      method: "textDocument/definition",
      params: (documents) => {
        const moduleB = documentByName(documents, "module_b.py");
        return {
          textDocument: { uri: moduleB.uri },
          position: positionInText(moduleB.text, "class FriendlyGreeter(Greeter):", "Greeter):"),
        };
      },
      assertResponse: (response, workspacePlaceholderUri) =>
        assertDefinitionIncludesFile(response, workspacePlaceholderUri, "module_a.py"),
    },
    {
      name: "completion-module_a-context",
      method: "textDocument/completion",
      params: (documents) => {
        const moduleA = documentByName(documents, "module_a.py");
        return {
          textDocument: { uri: moduleA.uri },
          position: positionAfterText(
            moduleA.text,
            "        return format_greeting(self.prefix, name)",
            "self.",
          ),
        };
      },
      assertResponse: assertCompletionResponse,
    },
    {
      name: "references-module_a-class",
      method: "textDocument/references",
      params: (documents) => {
        const moduleA = documentByName(documents, "module_a.py");
        return {
          textDocument: { uri: moduleA.uri },
          position: positionInText(moduleA.text, "class Greeter:", "Greeter"),
          context: { includeDeclaration: true },
        };
      },
      assertResponse: (response, workspacePlaceholderUri) =>
        assertLocationsIncludeFiles(response, workspacePlaceholderUri, [
          "module_a.py",
          "module_b.py",
        ]),
    },
    {
      name: "references-module_b-cross-file",
      method: "textDocument/references",
      params: (documents) => {
        const moduleB = documentByName(documents, "module_b.py");
        return {
          textDocument: { uri: moduleB.uri },
          position: positionInText(moduleB.text, "make_greeter()", "make_greeter"),
          context: { includeDeclaration: true },
        };
      },
      assertResponse: (response, workspacePlaceholderUri) =>
        assertLocationsIncludeFiles(response, workspacePlaceholderUri, [
          "module_a.py",
          "module_b.py",
        ]),
    },
    {
      name: "document-symbol-module_a",
      method: "textDocument/documentSymbol",
      params: (documents) => ({
        textDocument: { uri: documentByName(documents, "module_a.py").uri },
      }),
      assertResponse: assertDocumentSymbolResponse,
    },
    {
      name: "document-highlight-module_a-readwrite",
      method: "textDocument/documentHighlight",
      params: (documents) => {
        const moduleA = documentByName(documents, "module_a.py");
        return {
          textDocument: { uri: moduleA.uri },
          position: positionInText(moduleA.text, "    counter = counter + 1", "counter"),
        };
      },
      assertResponse: assertDocumentHighlightResponse,
    },
    {
      name: "workspace-symbol-greet",
      method: "workspace/symbol",
      params: () => ({ query: "greet" }),
      assertResponse: assertWorkspaceSymbolResponse,
    },
  ];
}

function normalizeFixtureValue(value: unknown, workspaceRootUri: string): unknown {
  if (typeof value === "string") {
    if (value === workspaceRootUri) return WORKSPACE_PLACEHOLDER_URI;
    if (value.startsWith(`${workspaceRootUri}/`)) {
      return `${WORKSPACE_PLACEHOLDER_URI}${value.slice(workspaceRootUri.length)}`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeFixtureValue(item, workspaceRootUri));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalizeFixtureValue(item, workspaceRootUri),
      ]),
    );
  }

  return value;
}

function normalizeResponseEnvelope(
  name: FixtureName,
  response: JsonRpcResponseEnvelope,
  workspaceRootUri: string,
): JsonRpcResponseEnvelope {
  const normalized: JsonRpcResponseEnvelope = {
    jsonrpc: "2.0",
    id: name,
  };
  if ("result" in response)
    normalized.result = normalizeFixtureValue(response.result, workspaceRootUri);
  if (response.error) normalized.error = response.error;
  return normalized;
}

function snapshotFileName(name: FixtureName): FixtureFileName {
  return `${name}.json`;
}

function writeSnapshot(
  paths: CapturePaths,
  name: FixtureName,
  snapshot: PyrightFixtureSnapshot,
): void {
  mkdirSync(paths.responsesDir, { recursive: true });
  writeFileSync(
    resolve(paths.responsesDir, snapshotFileName(name)),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    "utf8",
  );
}

async function openFixtureDocuments(
  client: JsonRpcStdioClient,
  documents: FixtureTextDocument[],
): Promise<void> {
  for (const document of documents) {
    client.notify("textDocument/didOpen", {
      textDocument: {
        uri: document.uri,
        languageId: "python",
        version: 1,
        text: document.text,
      },
    });
  }
  await sleep(DID_OPEN_SETTLE_MS);
}

export async function capturePyrightFixtureSnapshots(
  options: { writeSnapshots?: boolean } = {},
): Promise<Map<FixtureName, PyrightFixtureSnapshot>> {
  const paths = buildPyrightFixturePaths();
  ensurePyrightSampleFiles(paths);

  const pyrightVersion = readPyrightVersion(paths.repoRoot);
  assertExpectedPyrightVersion(pyrightVersion);

  const workspaceRootUri = absolutePathToFileUri(paths.sampleDir);
  const documents = fixtureDocuments(paths);
  const proc = spawn(paths.pyrightBin, ["--stdio"], {
    cwd: paths.repoRoot,
    stdio: "pipe",
    env: { ...process.env },
  });
  const client = new JsonRpcStdioClient(proc, {
    uri: workspaceRootUri,
    name: "pyright-fixture-workspace",
  });

  try {
    await client.requestEnvelope("initialize", buildInitializeParams(workspaceRootUri));
    client.notify("initialized", {});
    await openFixtureDocuments(client, documents);

    const snapshots = new Map<FixtureName, PyrightFixtureSnapshot>();
    for (const scenario of scenarios()) {
      const requestParams = scenario.params(documents);
      const response = await client.requestEnvelope(scenario.method, requestParams);
      const normalizedResponse = normalizeResponseEnvelope(
        scenario.name,
        response,
        workspaceRootUri,
      );
      scenario.assertResponse(normalizedResponse, WORKSPACE_PLACEHOLDER_URI);

      const snapshot: PyrightFixtureSnapshot = {
        pyrightVersion,
        workspaceRoot: WORKSPACE_PLACEHOLDER_URI,
        request: {
          method: scenario.method,
          params: normalizeFixtureValue(requestParams, workspaceRootUri),
        },
        response: normalizedResponse,
      };
      snapshots.set(scenario.name, snapshot);
      if (options.writeSnapshots !== false) writeSnapshot(paths, scenario.name, snapshot);
    }
    return snapshots;
  } finally {
    await client.shutdown();
    client.forceDispose();
  }
}

async function main(): Promise<void> {
  const snapshots = await capturePyrightFixtureSnapshots();
  console.log(`pyrightVersion=${EXPECTED_PYRIGHT_VERSION}`);
  for (const name of snapshots.keys()) {
    console.log(
      `wrote ${resolve(buildPyrightFixturePaths().responsesDir, snapshotFileName(name))}`,
    );
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`capture failed: ${message}`);
    process.exit(1);
  });
}
