// LSP manager — owns one TypeScript language server instance per workspace.
// Runs inside the lsp-host utility process; communicates with the main process
// via MessagePort set up by lspHost.ts in the main process.
//
// Lifecycle: lazy spawn on first didOpen, 30-minute idle graceful shutdown.

import { TypeScriptServer } from "./servers/typescript";

// Inbound message shapes (main → utility)
interface CallMsg {
  type: "call";
  id: string | number;
  method: string;
  args: unknown;
}

type InboundMsg = CallMsg;

// MessagePort structural type (no electron import in utility)
interface IMessagePort {
  on: (event: "message", handler: (e: { data: unknown }) => void) => void;
  start: () => void;
  postMessage: (data: unknown) => void;
}

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export class LspManager {
  private port: IMessagePort | null = null;
  // keyed by workspaceId
  private servers = new Map<string, TypeScriptServer>();
  // keyed by workspaceId — timer handle for idle shutdown
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  attachPort(port: IMessagePort): void {
    this.port = port;
    port.on("message", (event) => {
      this.handleMessage(event.data as InboundMsg);
    });
    port.start();
  }

  private send(msg: unknown): void {
    if (this.port) {
      this.port.postMessage(msg);
    }
  }

  private handleMessage(msg: InboundMsg): void {
    if (msg.type === "call") {
      this.handleCall(msg).catch((err: unknown) => {
        this.send({
          type: "response",
          id: msg.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  private async handleCall(msg: CallMsg): Promise<void> {
    const { id, method, args } = msg;
    const a = args as Record<string, unknown>;

    switch (method) {
      case "didOpen": {
        const workspaceId = a.workspaceId as string;
        const server = await this.getOrCreateServer(workspaceId);
        this.resetIdleTimer(workspaceId);
        await server.didOpen(
          a.uri as string,
          a.languageId as string,
          a.version as number,
          a.text as string
        );
        this.send({ type: "response", id, result: null });
        break;
      }
      case "didChange": {
        const uri = a.uri as string;
        const workspaceId = this.findWorkspaceForUri(uri);
        if (workspaceId) {
          const server = this.servers.get(workspaceId);
          if (server) {
            this.resetIdleTimer(workspaceId);
            await server.didChange(uri, a.version as number, a.text as string);
          }
        }
        this.send({ type: "response", id, result: null });
        break;
      }
      case "hover": {
        const uri = a.uri as string;
        const workspaceId = this.findWorkspaceForUri(uri);
        const server = workspaceId ? this.servers.get(workspaceId) : undefined;
        if (server) {
          this.resetIdleTimer(workspaceId!);
          const result = await server.hover(uri, a.line as number, a.character as number);
          this.send({ type: "response", id, result });
        } else {
          this.send({ type: "response", id, result: null });
        }
        break;
      }
      case "definition": {
        const uri = a.uri as string;
        const workspaceId = this.findWorkspaceForUri(uri);
        const server = workspaceId ? this.servers.get(workspaceId) : undefined;
        if (server) {
          this.resetIdleTimer(workspaceId!);
          const result = await server.definition(uri, a.line as number, a.character as number);
          this.send({ type: "response", id, result });
        } else {
          this.send({ type: "response", id, result: [] });
        }
        break;
      }
      case "completion": {
        const uri = a.uri as string;
        const workspaceId = this.findWorkspaceForUri(uri);
        const server = workspaceId ? this.servers.get(workspaceId) : undefined;
        if (server) {
          this.resetIdleTimer(workspaceId!);
          const result = await server.completion(uri, a.line as number, a.character as number);
          this.send({ type: "response", id, result });
        } else {
          this.send({ type: "response", id, result: [] });
        }
        break;
      }
      default:
        this.send({ type: "response", id, error: `unknown method: ${method}` });
    }
  }

  private async getOrCreateServer(workspaceId: string): Promise<TypeScriptServer> {
    let server = this.servers.get(workspaceId);
    if (!server) {
      server = new TypeScriptServer(workspaceId, (uri, diagnostics) => {
        this.send({ type: "diagnostics", uri, diagnostics });
      });
      await server.start();
      this.servers.set(workspaceId, server);
    }
    return server;
  }

  // Find the workspaceId that owns a given uri.
  // M0: single workspace — return the first one found.
  private findWorkspaceForUri(_uri: string): string | undefined {
    return this.servers.keys().next().value;
  }

  private resetIdleTimer(workspaceId: string): void {
    const existing = this.idleTimers.get(workspaceId);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const handle = setTimeout(() => {
      this.idleTimers.delete(workspaceId);
      this.shutdownServer(workspaceId);
    }, IDLE_TIMEOUT_MS);
    this.idleTimers.set(workspaceId, handle);
  }

  private shutdownServer(workspaceId: string): void {
    const server = this.servers.get(workspaceId);
    if (server) {
      this.servers.delete(workspaceId);
      server.dispose();
    }
  }

  disposeAll(): void {
    for (const [workspaceId] of this.servers) {
      const handle = this.idleTimers.get(workspaceId);
      if (handle !== undefined) {
        clearTimeout(handle);
      }
      this.shutdownServer(workspaceId);
    }
    this.idleTimers.clear();
  }
}
