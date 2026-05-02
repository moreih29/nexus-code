// TypeScript language server wrapper.
// Spawns typescript-language-server --stdio as a child process and
// bridges JSON-RPC over stdio to the LSP manager.

import { type ChildProcess, spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";

// ---------------------------------------------------------------------------
// LSP message types (minimal subset used by M0)
// ---------------------------------------------------------------------------

interface DiagnosticItem {
  line: number;
  character: number;
  message: string;
  severity: number;
}

interface HoverResult {
  contents: string;
}

interface LocationResult {
  uri: string;
  line: number;
  character: number;
}

interface CompletionItem {
  label: string;
  kind?: number;
}

type DiagnosticsCallback = (uri: string, diagnostics: DiagnosticItem[]) => void;

// ---------------------------------------------------------------------------
// JSON-RPC framing helpers
// ---------------------------------------------------------------------------

function encodeMessage(msg: unknown): Buffer {
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, "ascii"), Buffer.from(body, "utf8")]);
}

// ---------------------------------------------------------------------------
// TypeScriptServer
// ---------------------------------------------------------------------------

export class TypeScriptServer {
  private proc: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private initialized = false;
  private disposed = false;

  constructor(
    private readonly workspaceId: string,
    private readonly onDiagnostics: DiagnosticsCallback,
  ) {}

  async start(): Promise<void> {
    // In dev: __dirname = <project>/out/main; binary is at <project>/node_modules/.bin/
    // Go up two levels from out/main to reach project root.
    const binPath = resolvePath(__dirname, "../../node_modules/.bin/typescript-language-server");

    this.proc = spawn(binPath, ["--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    // biome-ignore lint/style/noNonNullAssertion: stdio:'pipe' guarantees stdout is non-null
    this.proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    // biome-ignore lint/style/noNonNullAssertion: stdio:'pipe' guarantees stderr is non-null
    this.proc.stderr!.on("data", (chunk: Buffer) => {
      process.stderr.write(`[lsp-ts:${this.workspaceId}] ${chunk}`);
    });
    this.proc.on("exit", (code) => {
      if (!this.disposed) {
        console.warn(`[lsp-ts:${this.workspaceId}] exited with code ${code}`);
      }
      for (const [, p] of this.pending) {
        p.reject(new Error("typescript-language-server process exited"));
      }
      this.pending.clear();
    });

    await this.sendInitialize();
    this.initialized = true;
  }

  private async sendInitialize(): Promise<void> {
    await this.request("initialize", {
      processId: process.pid,
      rootUri: null,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["plaintext", "markdown"] },
          definition: {},
          completion: {
            completionItem: { snippetSupport: false },
          },
          publishDiagnostics: {},
        },
        workspace: {},
      },
      initializationOptions: {},
    });
    this.notify("initialized", {});
  }

  async didOpen(uri: string, languageId: string, version: number, text: string): Promise<void> {
    if (!this.initialized) return;
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text },
    });
  }

  async didChange(uri: string, version: number, text: string): Promise<void> {
    if (!this.initialized) return;
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  async hover(uri: string, line: number, character: number): Promise<HoverResult | null> {
    if (!this.initialized) return null;
    const result = await this.request("textDocument/hover", {
      textDocument: { uri },
      position: { line, character },
    });
    if (!result) return null;
    const r = result as { contents?: unknown };
    if (!r.contents) return null;
    const raw = r.contents;
    let text = "";
    if (typeof raw === "string") {
      text = raw;
    } else if (typeof raw === "object" && raw !== null && "value" in raw) {
      text = (raw as { value: string }).value;
    } else if (Array.isArray(raw)) {
      text = (raw as Array<{ value?: string } | string>)
        .map((item) => (typeof item === "string" ? item : (item.value ?? "")))
        .join("\n");
    }
    return { contents: text };
  }

  async definition(uri: string, line: number, character: number): Promise<LocationResult[]> {
    if (!this.initialized) return [];
    const result = await this.request("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    });
    if (!result) return [];
    const items = Array.isArray(result) ? result : [result];
    return items.map((loc: unknown) => {
      const l = loc as { uri: string; range: { start: { line: number; character: number } } };
      return {
        uri: l.uri,
        line: l.range.start.line,
        character: l.range.start.character,
      };
    });
  }

  async completion(uri: string, line: number, character: number): Promise<CompletionItem[]> {
    if (!this.initialized) return [];
    const result = await this.request("textDocument/completion", {
      textDocument: { uri },
      position: { line, character },
    });
    if (!result) return [];
    const items = Array.isArray(result) ? result : ((result as { items?: unknown[] }).items ?? []);
    return (items as Array<{ label: string; kind?: number }>).map((item) => ({
      label: item.label,
      kind: item.kind,
    }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
        setTimeout(() => {
          try {
            this.proc?.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, 5000);
      } catch {
        /* ignore */
      }
    }
  }

  // ---------------------------------------------------------------------------
  // JSON-RPC low-level
  // ---------------------------------------------------------------------------

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.disposed || !this.proc) {
        reject(new Error("server disposed"));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const msg = { jsonrpc: "2.0", id, method, params };
      // biome-ignore lint/style/noNonNullAssertion: stdio:'pipe' guarantees stdin is non-null
      this.proc.stdin!.write(encodeMessage(msg));
    });
  }

  private notify(method: string, params: unknown): void {
    if (this.disposed || !this.proc) return;
    const msg = { jsonrpc: "2.0", method, params };
    // biome-ignore lint/style/noNonNullAssertion: stdio:'pipe' guarantees stdin is non-null
    this.proc.stdin!.write(encodeMessage(msg));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.parseMessages();
  }

  private parseMessages(): void {
    while (true) {
      // Find header boundary
      const sep = this.buffer.indexOf("\r\n\r\n");
      if (sep === -1) break;

      const header = this.buffer.slice(0, sep).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Malformed — discard up to separator
        this.buffer = this.buffer.slice(sep + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = sep + 4;
      if (this.buffer.length < bodyStart + contentLength) break;

      const body = this.buffer.slice(bodyStart, bodyStart + contentLength).toString("utf8");
      this.buffer = this.buffer.slice(bodyStart + contentLength);

      let msg: unknown;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }

      this.handleMessage(msg as Record<string, unknown>);
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if ("id" in msg && ("result" in msg || "error" in msg)) {
      // Response
      const id = msg.id as number;
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        if (msg.error) {
          const err = msg.error as { message?: string };
          pending.reject(new Error(err.message ?? "LSP error"));
        } else {
          pending.resolve(msg.result ?? null);
        }
      }
    } else if ("method" in msg && !("id" in msg)) {
      // Notification from server
      const method = msg.method as string;
      if (method === "textDocument/publishDiagnostics") {
        const params = msg.params as {
          uri: string;
          diagnostics: Array<{
            range: { start: { line: number; character: number } };
            message: string;
            severity?: number;
          }>;
        };
        const diagnostics: DiagnosticItem[] = params.diagnostics.map((d) => ({
          line: d.range.start.line,
          character: d.range.start.character,
          message: d.message,
          severity: d.severity ?? 1,
        }));
        this.onDiagnostics(params.uri, diagnostics);
      }
    }
  }
}
