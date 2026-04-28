export type JsonRpcId = number | string;
export type JsonRpcPayload = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export interface LspProtocolWritable {
  write(chunk: string | Buffer): boolean;
}

export interface LspProtocolTransport {
  stdin: LspProtocolWritable | null;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface LspProtocolClientOptions {
  serverName: string;
  onServerMessage(payload: JsonRpcRequest | JsonRpcNotification): void;
}

export class LspProtocolClient {
  private readonly pendingRequests = new Map<JsonRpcId, PendingRequest>();
  private readonly parser: JsonRpcMessageParser;
  private nextRequestId = 1;

  public constructor(private readonly options: LspProtocolClientOptions) {
    this.parser = new JsonRpcMessageParser((payload) => this.handlePayload(payload));
  }

  public get messageParser(): JsonRpcMessageParser {
    return this.parser;
  }

  public sendRequest(
    transport: LspProtocolTransport,
    method: string,
    params?: unknown,
  ): Promise<unknown> {
    const id = this.nextRequestId++;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        method,
        resolve,
        reject,
      });
      try {
        writeJsonRpcPayload(transport, this.options.serverName, payload);
      } catch (error) {
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  public sendNotification(
    transport: LspProtocolTransport,
    method: string,
    params?: unknown,
  ): void {
    writeJsonRpcPayload(transport, this.options.serverName, {
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  public rejectPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      this.pendingRequests.delete(id);
      pending.reject(error);
    }
  }

  private handlePayload(payload: JsonRpcPayload): void {
    if (isJsonRpcResponse(payload)) {
      const pending = this.pendingRequests.get(payload.id);
      if (!pending) {
        return;
      }

      this.pendingRequests.delete(payload.id);
      if (payload.error) {
        pending.reject(new Error(payload.error.message ?? `${pending.method} failed.`));
      } else {
        pending.resolve(payload.result);
      }
      return;
    }

    this.options.onServerMessage(payload);
  }
}

export class JsonRpcMessageParser {
  private buffer = Buffer.alloc(0);

  public constructor(private readonly onMessage: (payload: JsonRpcPayload) => void) {}

  public push(chunk: Buffer | string): void {
    const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    this.buffer = Buffer.concat([this.buffer, nextChunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const contentLength = parseContentLength(header);
      if (contentLength === null) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (this.buffer.length < messageEnd) {
        return;
      }

      const body = this.buffer.subarray(messageStart, messageEnd).toString("utf8");
      this.buffer = this.buffer.subarray(messageEnd);
      try {
        this.onMessage(JSON.parse(body) as JsonRpcPayload);
      } catch {
        // Ignore malformed server messages; status updates come from process lifecycle.
      }
    }
  }
}

function writeJsonRpcPayload(
  transport: LspProtocolTransport,
  serverName: string,
  payload: JsonRpcPayload,
): void {
  if (!transport.stdin) {
    throw new Error(`${serverName} stdin is unavailable.`);
  }

  const body = JSON.stringify(payload);
  transport.stdin.write(
    `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`,
  );
}

function parseContentLength(header: string): number | null {
  for (const line of header.split("\r\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    if (key !== "content-length") {
      continue;
    }
    const value = Number(line.slice(separatorIndex + 1).trim());
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  return null;
}

function isJsonRpcResponse(payload: JsonRpcPayload): payload is JsonRpcResponse {
  return "id" in payload && !("method" in payload);
}
