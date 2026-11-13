/**
 * Voice input's socket to the server (GET /voice), held here rather than
 * in the renderer: the server refuses an upgrade with a status and a JSON
 * error (403 quota_exceeded, 429 too_many_sessions, 503 voice_unavailable),
 * which `ws` reads and a page's WebSocket cannot. The renderer sends the
 * captured audio; what the server says comes back as events. One session
 * at a time: the app has one place being dictated into.
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { z } from "zod";
import {
  VOICE_VERSION,
  type VoiceServerMessage,
  VoiceServerMessageSchema,
  type VoiceUsage,
  VoiceUsageSchema,
} from "../../../../packages/remote-protocol/src/voice";
import type { VoiceEvent, VoiceFailure, VoiceStartResult } from "../../../shared/remote/voice";
import type { RemoteAccount } from "./account";
import { ServerError, SignedOutError, UnreachableError } from "./errors";

/** POST /relay/ticket's answer: a short-lived ticket a socket signs in with (/relay, /voice). */
export const TicketSchema = z.object({ ticket: z.string().min(1) });

/** How long the server has to say `ready` once the socket is open. */
export const READY_TIMEOUT_MS = 10_000;
/** How long after `end` the socket is closed if the server has not finished. */
export const END_TIMEOUT_MS = 8_000;

/** The part of a `ws` socket used here, so a test can stand in for it. */
export interface VoiceSocket {
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number): void;
  terminate(): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: WebSocket.RawData, binary: boolean) => void): this;
  on(event: "close", listener: (code: number) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(
    event: "unexpected-response",
    listener: (request: unknown, response: UpgradeRefusal) => void,
  ): this;
}

/** The refused upgrade's response, as much of it as is read. */
export interface UpgradeRefusal {
  statusCode?: number;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "end", listener: () => void): unknown;
}

export interface VoiceSessionsDeps {
  account: Pick<RemoteAccount, "state" | "info" | "request">;
  emit(event: VoiceEvent): void;
  socket?: (url: string) => VoiceSocket;
}

interface Open {
  id: string;
  socket: VoiceSocket;
  endTimer?: ReturnType<typeof setTimeout>;
}

/** Why the server refused the upgrade, from its status and its body's `error`. */
export function refusalOf(status: number | undefined, code: string | undefined): VoiceFailure {
  if (status === 401 || code === "unauthorized") return "signed-out";
  if (status === 403 || code === "quota_exceeded") return "quota";
  if (status === 429 || code === "too_many_sessions") return "busy";
  if (status === 503 || code === "voice_unavailable") return "unavailable";
  return "failed";
}

function failed(reason: VoiceFailure, message: string): VoiceStartResult {
  return { status: "failed", reason, message };
}

export class VoiceSessions {
  private open: Open | null = null;
  /** A start under way, so a second click does not open a second socket. */
  private starting = false;

  constructor(private readonly deps: VoiceSessionsDeps) {}

  /** Opens a session in `language`: ready with the rate to send at, or why not. */
  async start(language: string): Promise<VoiceStartResult> {
    if (this.open || this.starting) return failed("in-use", "voice input is already on");
    this.starting = true;
    try {
      return await this.connect(language);
    } finally {
      this.starting = false;
    }
  }

  private async connect(language: string): Promise<VoiceStartResult> {
    const { account } = this.deps;
    const state = account.state();
    if (state.status !== "signed-in") return failed("signed-out", "not signed in to NexusCode");
    let ticket: string;
    try {
      const info = await account.info();
      if (!info.voice) return failed("unavailable", "the server has no voice input");
      ({ ticket } = TicketSchema.parse(await account.request("POST", "/relay/ticket")));
    } catch (error) {
      if (error instanceof SignedOutError) return failed("signed-out", error.message);
      if (error instanceof UnreachableError) return failed("network", error.message);
      if (error instanceof ServerError) return failed("failed", error.message);
      throw error;
    }
    const url = new URL("/voice", state.server);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.search = new URLSearchParams({
      v: String(VOICE_VERSION),
      lang: language,
      ticket,
    }).toString();
    const socket = (this.deps.socket ?? ((u) => new WebSocket(u) as unknown as VoiceSocket))(
      url.toString(),
    );
    const id = randomUUID();

    return new Promise<VoiceStartResult>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        settle(failed("network", "the server did not get voice input ready"));
        socket.terminate();
      }, READY_TIMEOUT_MS);
      const settle = (result: VoiceStartResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (result.status === "ready") this.open = { id, socket };
        resolve(result);
      };

      socket.on("unexpected-response", (_request, response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk.toString("utf8");
        });
        response.on("end", () => {
          const code = errorOf(body);
          settle(
            failed(
              refusalOf(response.statusCode, code),
              `the server refused voice input (${response.statusCode ?? "?"}${code ? ` ${code}` : ""})`,
            ),
          );
          socket.terminate();
        });
      });
      socket.on("error", (error) => {
        settle(failed("network", error.message));
      });
      socket.on("message", (data, binary) => {
        if (binary) return;
        const message = parseMessage(data);
        if (!message) return;
        if (!settled) {
          if (message.t === "ready") {
            settle({
              status: "ready",
              id,
              sampleRate: message.sampleRate,
              maxSeconds: message.maxSeconds,
            });
          } else if (message.t === "error") {
            settle(
              failed(message.code === "unauthorized" ? "signed-out" : "failed", message.message),
            );
          }
          return;
        }
        if (this.open?.id === id) this.deps.emit({ id, event: message });
      });
      socket.on("close", (code) => {
        settle(failed("network", `the voice socket closed (${code})`));
        if (this.open?.id !== id) return;
        clearTimeout(this.open.endTimer);
        this.open = null;
        this.deps.emit({ id, event: { t: "closed", code } });
      });
    });
  }

  /** Sends audio to the open session; audio for another, or after it ended, is dropped. */
  audio(id: string, audio: Uint8Array): void {
    const open = this.open;
    if (!open || open.id !== id || open.endTimer || open.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    open.socket.send(audio);
  }

  /** The user stopped: the server sends what is left of the text, then `done`, then closes. */
  stop(id: string): void {
    const open = this.open;
    if (!open || open.id !== id || open.endTimer) return;
    if (open.socket.readyState === WebSocket.OPEN) open.socket.send(JSON.stringify({ t: "end" }));
    open.endTimer = setTimeout(() => open.socket.close(1000), END_TIMEOUT_MS);
  }

  /** Drops the session without waiting for the rest of its text. */
  cancel(id?: string): void {
    const open = this.open;
    if (!open || (id !== undefined && open.id !== id)) return;
    open.socket.close(1000);
  }

  /** This month's voice minutes: used, and allowed. */
  async usage(): Promise<VoiceUsage> {
    return VoiceUsageSchema.parse(await this.deps.account.request("GET", "/voice/usage"));
  }
}

function errorOf(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const { error } = parsed as { error: unknown };
      return typeof error === "string" ? error : undefined;
    }
  } catch {}
  return undefined;
}

function parseMessage(data: WebSocket.RawData): VoiceServerMessage | null {
  const text = Array.isArray(data)
    ? Buffer.concat(data).toString("utf8")
    : Buffer.from(data as ArrayBuffer).toString("utf8");
  try {
    const parsed = VoiceServerMessageSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
