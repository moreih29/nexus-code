import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import WebSocket from "ws";
import { z } from "zod";
import {
  type Transcription,
  TranscriptionSchema,
  VOICE_VERSION,
  type VoicePurpose,
  type VoiceServerMessage,
  VoiceServerMessageSchema,
  type VoiceUsage,
  VoiceUsageSchema,
} from "../../../../packages/remote-protocol/src/voice";
import { bugReportErrorCode } from "../../../shared/remote/bug-report";
import {
  type TranscribeFailure,
  type TranscribeResult,
  VOICE_CLOSE_SIGNED_OUT,
  type VoiceEvent,
  type VoiceFailure,
  type VoiceStartResult,
  VoiceTermsSchema,
} from "../../../shared/remote/voice";
import {
  API_RESPONSE_MAX_BYTES,
  RESPONSE_TOO_LARGE,
  ResponseTooLargeError,
} from "../../infra/http/body";
import type { RecordError } from "../../infra/recent-errors";
import type { RemoteAccount } from "./account";
import { OutdatedError, ServerError, SignedOutError, UnreachableError } from "./errors";
import { retryAfterSeconds, SocketRetryAfter } from "./retry-after";
import { askTicket } from "./ticket";
import { voiceNamesOf } from "./voice-names";

export const READY_TIMEOUT_MS = 10_000;
export const END_TIMEOUT_MS = 8_000;
const DEFAULT_RETRY_AFTER_SECONDS = 60;

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

export interface UpgradeRefusal {
  statusCode?: number;
  headers: IncomingHttpHeaders;
  destroy(): void;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface VoiceSessionsDeps {
  account: Pick<RemoteAccount, "state" | "info" | "request" | "upload" | "route" | "recheckSignIn">;
  purpose?: VoicePurpose;
  emit(event: VoiceEvent): void;
  names?: () => Promise<readonly string[]>;
  socket?: (url: string) => VoiceSocket;
  retryAfter?: SocketRetryAfter;
  recordError?: RecordError;
}

interface Open {
  id: string;
  socket: VoiceSocket;
  endTimer?: ReturnType<typeof setTimeout>;
}

export function refusalOf(status: number | undefined, code: string | undefined): VoiceFailure {
  if (status === 429) return code === "too_many_sessions" ? "busy" : "rate-limited";
  if (status === 401 || code === "unauthorized" || code === "not_invited") return "signed-out";
  if (status === 403 || code === "quota_exceeded") return "quota";
  if (code === "too_many_sessions") return "busy";
  if (status === 503 || code === "voice_unavailable") return "unavailable";
  return "failed";
}

export function transcribeRefusalOf(error: ServerError): TranscribeFailure {
  if (error.code === "quota_exceeded") return "quota";
  if (error.status === 429 || error.code === "too_many_transcriptions") return "busy";
  if (error.status === 403) return "expired";
  if (error.status === 413) return "too-big";
  return "failed";
}

export function ticketBody(names: readonly string[]): { voiceTerms: string[] } | undefined {
  const voiceTerms = voiceNamesOf([names]);
  return voiceTerms.length > 0 ? { voiceTerms } : undefined;
}

function failed(reason: VoiceFailure, message: string): VoiceStartResult {
  return { status: "failed", reason, message };
}

export class VoiceSessions {
  private open: Open | null = null;
  private starting = false;
  private readonly retryAfter: SocketRetryAfter;

  constructor(private readonly deps: VoiceSessionsDeps) {
    this.retryAfter = deps.retryAfter ?? new SocketRetryAfter();
  }

  has(id: string): boolean {
    return this.open?.id === id;
  }

  private noteFailure(reason: string, message?: string): void {
    const code = bugReportErrorCode(this.deps.purpose ?? "input", reason);
    if (code) this.deps.recordError?.("voice", code, undefined, message);
  }

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
    if (this.retryAfter.remaining() > 0) return this.rateLimited();
    let ticket: string;
    const names = (this.deps.names?.() ?? Promise.resolve([])).catch(() => []);
    try {
      const info = await account.info();
      if (!info.voice) return failed("unavailable", "the server has no voice input");
      const body = ticketBody(await names);
      if (this.retryAfter.remaining() > 0) return this.rateLimited();
      ticket = await askTicket(account, body);
    } catch (error) {
      if (error instanceof SignedOutError) return failed("signed-out", error.message);
      if (error instanceof OutdatedError) return failed("outdated", error.message);
      if (error instanceof UnreachableError) return failed("network", error.message);
      if (error instanceof ServerError) {
        if (error.status === 429)
          return this.rateLimited(error.retryAfter ?? DEFAULT_RETRY_AFTER_SECONDS);
        return failed(
          error.code === RESPONSE_TOO_LARGE ? RESPONSE_TOO_LARGE : "failed",
          error.message,
        );
      }
      throw error;
    }
    if (this.retryAfter.remaining() > 0) return this.rateLimited();
    const url = account.route.url("/voice", { socket: true });
    url.search = new URLSearchParams({
      v: String(VOICE_VERSION),
      lang: language,
      ...(this.deps.purpose === "note" ? { purpose: "note" } : {}),
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
      const settle = (
        result: VoiceStartResult,
        recorded: "with-message" | "code-only" = "with-message",
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (result.status === "failed") {
          this.noteFailure(result.reason, recorded === "with-message" ? result.message : undefined);
        }
        if (result.status === "ready") this.open = { id, socket };
        resolve(result);
      };

      socket.on("unexpected-response", (_request, response) => {
        const retryAfter = retryAfterSeconds(response.headers["retry-after"]);
        if (!settled && response.statusCode === 429 && retryAfter !== undefined) {
          settle(this.rateLimited(retryAfter));
          socket.terminate();
          response.destroy();
          return;
        }
        const decoder = new TextDecoder();
        const body: string[] = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          if (settled) return;
          bytes += chunk.byteLength;
          if (bytes > API_RESPONSE_MAX_BYTES) {
            const error = new ResponseTooLargeError(API_RESPONSE_MAX_BYTES);
            body.length = 0;
            settle(failed(error.code, error.message));
            response.destroy();
            socket.terminate();
            return;
          }
          body.push(decoder.decode(chunk, { stream: true }));
        });
        response.on("end", () => {
          if (settled) return;
          body.push(decoder.decode());
          const code = errorOf(body.join(""));
          const reason = refusalOf(response.statusCode, code);
          settle(
            reason === "rate-limited"
              ? this.rateLimited(DEFAULT_RETRY_AFTER_SECONDS)
              : failed(
                  reason,
                  `the server refused voice input (${response.statusCode ?? "?"}${code ? ` ${code}` : ""})`,
                ),
          );
          socket.terminate();
        });
        response.on("error", (error) => {
          if (settled) return;
          settle(failed("network", error.message));
          socket.terminate();
        });
      });
      socket.on("error", (error) => {
        if (!settled) account.route.unreachable(url.toString());
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
              "code-only",
            );
          }
          return;
        }
        if (this.open?.id === id) this.deps.emit({ id, event: message });
      });
      socket.on("close", (code) => {
        const signedOut = code === VOICE_CLOSE_SIGNED_OUT;
        if (signedOut) account.recheckSignIn();
        settle(failed(signedOut ? "signed-out" : "network", `the voice socket closed (${code})`));
        if (this.open?.id !== id) return;
        clearTimeout(this.open.endTimer);
        this.open = null;
        this.deps.emit({ id, event: { t: "closed", code } });
      });
    });
  }

  private rateLimited(seconds?: number): VoiceStartResult {
    if (seconds !== undefined) this.retryAfter.pause(seconds);
    return failed("rate-limited", "the server limited voice connection attempts");
  }

  audio(id: string, audio: Uint8Array): void {
    const open = this.open;
    if (!open || open.id !== id || open.endTimer || open.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    open.socket.send(audio);
  }

  stop(id: string): void {
    const open = this.open;
    if (!open || open.id !== id || open.endTimer) return;
    if (open.socket.readyState === WebSocket.OPEN) open.socket.send(JSON.stringify({ t: "end" }));
    open.endTimer = setTimeout(() => open.socket.close(1000), END_TIMEOUT_MS);
  }

  cancel(id?: string): void {
    const open = this.open;
    if (!open || (id !== undefined && open.id !== id)) return;
    open.socket.close(1000);
  }

  async usage(): Promise<VoiceUsage> {
    return VoiceUsageSchema.parse(await this.deps.account.request("GET", "/voice/usage"));
  }

  async terms(): Promise<string[]> {
    return VoiceTermsSchema.parse(await this.deps.account.request("GET", "/voice/terms")).terms;
  }

  async setTerms(terms: readonly string[]): Promise<string[]> {
    return VoiceTermsSchema.parse(await this.deps.account.request("PUT", "/voice/terms", { terms }))
      .terms;
  }

  async transcribe(
    recording: Uint8Array,
    type: string,
    token: string,
    language: string,
  ): Promise<TranscribeResult> {
    const query = new URLSearchParams({ v: String(VOICE_VERSION), lang: language });
    try {
      const answer = await this.deps.account.upload(`/voice/transcriptions?${query}`, recording, {
        type,
        headers: { "x-transcribe-token": token },
      });
      return { status: "submitted", id: SubmittedSchema.parse(answer).id };
    } catch (error) {
      if (error instanceof SignedOutError)
        return { status: "failed", reason: "signed-out", message: error.message };
      if (error instanceof UnreachableError)
        return { status: "failed", reason: "network", message: error.message };
      if (error instanceof ServerError) {
        return { status: "failed", reason: transcribeRefusalOf(error), message: error.message };
      }
      throw error;
    }
  }

  async transcription(id: string): Promise<Transcription> {
    const transcription = TranscriptionSchema.parse(
      await this.deps.account.request("GET", `/voice/transcriptions/${encodeURIComponent(id)}`),
    );
    if (transcription.status === "error") this.deps.recordError?.("voice", "transcription:error");
    return transcription;
  }

  async dropTranscription(id: string): Promise<void> {
    await this.deps.account.request("DELETE", `/voice/transcriptions/${encodeURIComponent(id)}`);
  }
}

const SubmittedSchema = z.object({ id: z.string().min(1) });

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
