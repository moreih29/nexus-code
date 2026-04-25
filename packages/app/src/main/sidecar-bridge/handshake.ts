import { setTimeout as delay } from "node:timers/promises";
import type { ChildProcess } from "node:child_process";
import WebSocket from "ws";

import type {
  SidecarStartCommand,
  SidecarStartedEvent,
} from "../../../../shared/src/contracts/sidecar";

export interface ReadyLine {
  port: number;
  pid: number;
  version: number;
}

export class SidecarBridgeError extends Error {
  public constructor(
    message: string,
    public readonly kind: "fatal" | "transient",
    public readonly code: string,
  ) {
    super(message);
  }
}

const READY_PATTERN = /^NEXUS_SIDECAR_READY port=(\d+) pid=(\d+) proto=ws v=(\d+)$/;

export function parseReadyLine(line: string): ReadyLine {
  const match = READY_PATTERN.exec(line.trim());
  if (!match) {
    throw new SidecarBridgeError("READY line format mismatch", "fatal", "READY_FORMAT");
  }

  return {
    port: Number(match[1]),
    pid: Number(match[2]),
    version: Number(match[3]),
  };
}

export async function waitForReadyLine(
  childProcess: ChildProcess,
  timeoutMs = 5_000,
): Promise<ReadyLine> {
  if (!childProcess.stdout) {
    throw new SidecarBridgeError("sidecar stdout is unavailable", "fatal", "READY_STDOUT");
  }

  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new SidecarBridgeError("READY timeout", "transient", "READY_TIMEOUT"));
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      childProcess.stdout?.off("data", onData);
      childProcess.off("exit", onExit);
      childProcess.off("error", onError);
    };

    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      cleanup();
      try {
        resolve(parseReadyLine(buffer.slice(0, newlineIndex)));
      } catch (error) {
        reject(error);
      }
    };

    const onExit = (): void => {
      cleanup();
      reject(new SidecarBridgeError("sidecar exited before READY", "transient", "READY_EXIT"));
    };

    const onError = (error: Error): void => {
      cleanup();
      reject(new SidecarBridgeError(error.message, "transient", "SPAWN_ERROR"));
    };

    childProcess.stdout.on("data", onData);
    childProcess.once("exit", onExit);
    childProcess.once("error", onError);
  });
}

export async function connectWebSocket(
  port: number,
  token: string,
  timeoutMs = 2_000,
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, ["nexus.sidecar.v1"], {
    headers: { "X-Sidecar-Token": token },
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      ws.terminate();
      reject(new SidecarBridgeError("WebSocket 101 timeout", "transient", "WS_TIMEOUT"));
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("unexpected-response", onUnexpectedResponse);
    };

    const onOpen = (): void => {
      cleanup();
      if (ws.protocol !== "nexus.sidecar.v1") {
        ws.terminate();
        reject(new SidecarBridgeError("subprotocol negotiation failed", "fatal", "WS_PROTOCOL"));
        return;
      }
      resolve(ws);
    };

    const onError = (error: NodeJS.ErrnoException): void => {
      cleanup();
      if (error.message.includes("Expected 101 status code")) {
        reject(new SidecarBridgeError(error.message, "fatal", "WS_401"));
        return;
      }
      reject(new SidecarBridgeError(error.message, "transient", error.code ?? "WS_ERROR"));
    };

    const onUnexpectedResponse = (_request: unknown, response: { statusCode?: number }): void => {
      cleanup();
      const statusCode = response.statusCode;
      reject(
        new SidecarBridgeError(
          `WebSocket upgrade failed with ${statusCode ?? "unknown"}`,
          statusCode === 401 ? "fatal" : "transient",
          statusCode === 401 ? "WS_401" : "WS_UPGRADE",
        ),
      );
    };

    ws.once("open", onOpen);
    ws.on("error", onError);
    ws.once("unexpected-response", onUnexpectedResponse);
  });
}

export async function connectWebSocketWithRefusedRetry(
  port: number,
  token: string,
  timeoutMs = 2_000,
): Promise<WebSocket> {
  try {
    return await connectWebSocket(port, token, timeoutMs);
  } catch (error) {
    if (error instanceof SidecarBridgeError && error.code === "ECONNREFUSED") {
      await delay(250);
      return connectWebSocket(port, token, timeoutMs);
    }
    throw error;
  }
}

export async function performStartHandshake(
  ws: WebSocket,
  command: SidecarStartCommand,
  expectedPid: number,
  timeoutMs = 2_000,
): Promise<SidecarStartedEvent> {
  ws.send(JSON.stringify(command));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new SidecarBridgeError("SidecarStartedEvent timeout", "transient", "STARTED_TIMEOUT"));
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
    };

    const onMessage = (data: WebSocket.RawData): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        cleanup();
        reject(new SidecarBridgeError("StartedEvent JSON invalid", "fatal", "STARTED_SCHEMA"));
        return;
      }

      if (!isSidecarStartedEvent(parsed)) {
        cleanup();
        reject(new SidecarBridgeError("StartedEvent schema invalid", "fatal", "STARTED_SCHEMA"));
        return;
      }

      if (parsed.pid !== expectedPid) {
        cleanup();
        reject(new SidecarBridgeError("StartedEvent pid mismatch", "fatal", "PID_MISMATCH"));
        return;
      }

      cleanup();
      resolve(parsed);
    };

    const onClose = (): void => {
      cleanup();
      reject(new SidecarBridgeError("WebSocket closed before StartedEvent", "transient", "STARTED_CLOSE"));
    };

    const onError = (error: Error): void => {
      cleanup();
      reject(new SidecarBridgeError(error.message, "transient", "STARTED_ERROR"));
    };

    ws.on("message", onMessage);
    ws.once("close", onClose);
    ws.once("error", onError);
  });
}

export function isSidecarStartedEvent(value: unknown): value is SidecarStartedEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.type === "sidecar/started" &&
    typeof record.workspaceId === "string" &&
    typeof record.pid === "number" &&
    Number.isInteger(record.pid) &&
    typeof record.startedAt === "string"
  );
}
