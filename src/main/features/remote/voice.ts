/**
 * Voice input's socket to the server (GET /voice), held here rather than
 * in the renderer: the server refuses an upgrade with a status and a JSON
 * error (403 quota_exceeded, 429 too_many_sessions, 503 voice_unavailable),
 * which `ws` reads and a page's WebSocket cannot. The renderer sends the
 * captured audio; what the server says comes back as events. One session
 * at a time: the app has one place being dictated into (and, in a second
 * VoiceSessions, one note being recorded).
 *
 * A note's recording also goes once more, whole, to the server for a
 * second pass (POST /voice/transcriptions), which is asked after until it
 * is done and then deleted there.
 *
 * The server hears with three layers of terms: its own, the account's
 * (GET/PUT /voice/terms, edited in the settings), and, when the user turned
 * it on, the names of the moment (the account's computers and workspaces),
 * which go in the body of the ticket a session opens with: never in the
 * socket's URL, which the server's edge logs.
 */
import { randomUUID } from "node:crypto";
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
import {
  type TranscribeFailure,
  type TranscribeResult,
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
import type { RemoteAccount } from "./account";
import { OutdatedError, ServerError, SignedOutError, UnreachableError } from "./errors";
import { askTicket } from "./ticket";
import { voiceNamesOf } from "./voice-names";

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
  destroy(): void;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface VoiceSessionsDeps {
  account: Pick<RemoteAccount, "state" | "info" | "request" | "upload" | "route">;
  /** What the sessions are for; a note's carry voices, times and a second pass. */
  purpose?: VoicePurpose;
  emit(event: VoiceEvent): void;
  /**
   * The names of the moment to send with a session's ticket: none unless the
   * user turned it on. A failure sends none.
   */
  names?: () => Promise<readonly string[]>;
  socket?: (url: string) => VoiceSocket;
}

interface Open {
  id: string;
  socket: VoiceSocket;
  endTimer?: ReturnType<typeof setTimeout>;
}

/** Why the server refused the upgrade, from its status and its body's `error`. */
export function refusalOf(status: number | undefined, code: string | undefined): VoiceFailure {
  if (status === 401 || code === "unauthorized" || code === "not_invited") return "signed-out";
  if (status === 403 || code === "quota_exceeded") return "quota";
  if (status === 429 || code === "too_many_sessions") return "busy";
  if (status === 503 || code === "voice_unavailable") return "unavailable";
  return "failed";
}

/**
 * Why the server refused a second pass, from its status and its body's
 * `error`: over the month's minutes and too many under way leave the token
 * good for later; a used or old one does not.
 */
export function transcribeRefusalOf(error: ServerError): TranscribeFailure {
  if (error.code === "quota_exceeded") return "quota";
  if (error.status === 429 || error.code === "too_many_transcriptions") return "busy";
  if (error.status === 403) return "expired";
  if (error.status === 413) return "too-big";
  return "failed";
}

/**
 * The body of the POST /relay/ticket a voice session opens with: the names
 * to listen for, deduped, at most MAX_VOICE_NAMES, each clipped; no body
 * without names, as the relay's ticket is asked.
 */
export function ticketBody(names: readonly string[]): { voiceTerms: string[] } | undefined {
  const voiceTerms = voiceNamesOf([names]);
  return voiceTerms.length > 0 ? { voiceTerms } : undefined;
}

function failed(reason: VoiceFailure, message: string): VoiceStartResult {
  return { status: "failed", reason, message };
}

export class VoiceSessions {
  private open: Open | null = null;
  /** A start under way, so a second click does not open a second socket. */
  private starting = false;

  constructor(private readonly deps: VoiceSessionsDeps) {}

  /** Whether `id` is this one's open session. */
  has(id: string): boolean {
    return this.open?.id === id;
  }

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
    // Gathered while the server is asked what it offers.
    const names = (this.deps.names?.() ?? Promise.resolve([])).catch(() => []);
    try {
      const info = await account.info();
      if (!info.voice) return failed("unavailable", "the server has no voice input");
      const body = ticketBody(await names);
      ticket = await askTicket(account, body);
    } catch (error) {
      if (error instanceof SignedOutError) return failed("signed-out", error.message);
      if (error instanceof OutdatedError) return failed("outdated", error.message);
      if (error instanceof UnreachableError) return failed("network", error.message);
      if (error instanceof ServerError) {
        return failed(
          error.code === RESPONSE_TOO_LARGE ? RESPONSE_TOO_LARGE : "failed",
          error.message,
        );
      }
      throw error;
    }
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
      const settle = (result: VoiceStartResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (result.status === "ready") this.open = { id, socket };
        resolve(result);
      };

      socket.on("unexpected-response", (_request, response) => {
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
          settle(
            failed(
              refusalOf(response.statusCode, code),
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
        // Not reached before it answered: the next try goes straight when it was the proxy.
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

  /** The account's recognition terms, shared by all its devices. */
  async terms(): Promise<string[]> {
    return VoiceTermsSchema.parse(await this.deps.account.request("GET", "/voice/terms")).terms;
  }

  /**
   * Replaces the account's recognition terms: the list as the server kept
   * it (trimmed, duplicates in any case dropped).
   */
  async setTerms(terms: readonly string[]): Promise<string[]> {
    return VoiceTermsSchema.parse(await this.deps.account.request("PUT", "/voice/terms", { terms }))
      .terms;
  }

  /**
   * Sends a note's recording (one session's audio) for a second pass, with
   * the token that session's `done` gave: the transcription's id, or why
   * not.
   */
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

  /** A second pass: pending, done with its segments, or failed. */
  async transcription(id: string): Promise<Transcription> {
    return TranscriptionSchema.parse(
      await this.deps.account.request("GET", `/voice/transcriptions/${encodeURIComponent(id)}`),
    );
  }

  /** Has the server (and its provider) drop a second pass's recording and text. */
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
