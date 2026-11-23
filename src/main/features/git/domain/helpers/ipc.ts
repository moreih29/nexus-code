import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  type AskpassPrompt,
  AskpassPromptSchema,
  AskpassRespondArgsSchema,
  type GitEditorPrompt,
  GitEditorPromptSchema,
  GitEditorSaveArgsSchema,
  GitHelperPromptIdArgsSchema,
} from "../../../../../shared/git/types";
import { register, validateArgs } from "../../../../infra/ipc-router";
import { type GitHelperConnection, setDefaultGitHelperConnection } from "./launcher";

type BroadcastFn = (channelName: string, event: string, args: unknown) => void;

type HelperRoute = "editor.open";
const MAX_HELPER_REQUEST_BYTES = 1024 * 1024;
const MAX_EDITOR_FILE_BYTES = 4 * 1024 * 1024;
const DISCONNECTED: HelperWireResponse = { ok: false, error: "Git helper disconnected." };

interface HelperRequestLifetime {
  readonly signal: AbortSignal;
  promptOpened?(): void;
}

interface GitHelpersIpcManagerOptions {
  readonly userDataDir: string;
  readonly broadcast: BroadcastFn;
  readonly platform?: NodeJS.Platform;
  readonly pid?: number;
  readonly token?: string;
}

export interface GitHelpersEndpoint {
  readonly kind: "unix" | "pipe";
  readonly path: string;
  readonly dir?: string;
}

export interface HelperRequestPayload {
  readonly route?: string;
  readonly token?: string;
  readonly promptId?: string;
  readonly prompt?: string;
  readonly filePath?: string;
  readonly workspaceId?: string;
}

export interface HelperWireResponse {
  readonly ok: boolean;
  readonly value?: string;
  readonly error?: string;
}

export interface AgentAskpassPromptPayload {
  readonly requestId: string;
  readonly prompt: string;
  readonly workspaceId?: string;
}

export type AgentAskpassResponder = (secret: string | null) => Promise<void>;

type PendingPrompt =
  | {
      readonly kind: "askpass";
      readonly promptId: string;
      readonly resolve: (response: HelperWireResponse) => void;
    }
  | {
      readonly kind: "editor";
      readonly promptId: string;
      readonly filePath: string;
      readonly resolve: (response: HelperWireResponse) => void;
    };

export class GitHelpersIpcManager {
  private readonly userDataDir: string;
  private readonly broadcast: BroadcastFn;
  private readonly platform: NodeJS.Platform;
  private readonly pid: number;
  private readonly token: string;
  private readonly awaitingRequests = new Map<net.Socket, AbortController>();
  private readonly pending = new Map<string, PendingPrompt>();
  private server: net.Server | null = null;
  private endpoint: GitHelpersEndpoint | null = null;

  constructor(options: GitHelpersIpcManagerOptions) {
    this.userDataDir = options.userDataDir;
    this.broadcast = options.broadcast;
    this.platform = options.platform ?? process.platform;
    this.pid = options.pid ?? process.pid;
    this.token = options.token ?? crypto.randomBytes(32).toString("hex");
  }

  async start(): Promise<GitHelperConnection> {
    if (this.server && this.endpoint) return this.connection();

    const endpoint = await prepareGitHelpersEndpoint({
      userDataDir: this.userDataDir,
      platform: this.platform,
      pid: this.pid,
    });
    const server = net.createServer((socket) => {
      this.handleSocket(socket);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint.path, () => {
        server.off("error", reject);
        resolve();
      });
    });

    this.server = server;
    this.endpoint = endpoint;
    setDefaultGitHelperConnection(this.connection());
    return this.connection();
  }

  async dispose(): Promise<void> {
    for (const pending of Array.from(this.pending.values())) {
      pending.resolve({ ok: false, error: "Git helper manager stopped." });
      this.pending.delete(pending.promptId);
    }

    const server = this.server;
    const endpoint = this.endpoint;
    this.server = null;
    this.endpoint = null;
    setDefaultGitHelperConnection(null);

    if (server) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const [socket, lifetime] of this.awaitingRequests) {
        lifetime.abort();
        socket.destroy();
      }
      await closed;
    }
    if (endpoint?.kind === "unix") {
      await fs.unlink(endpoint.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  connection(): GitHelperConnection {
    if (!this.endpoint) {
      throw new Error("Git helper manager has not started.");
    }
    return { socketPath: this.endpoint.path, token: this.token };
  }

  async handleHelperRequest(
    payload: HelperRequestPayload,
    lifetime?: HelperRequestLifetime,
  ): Promise<HelperWireResponse> {
    this.assertAuthorizedPayload(payload);

    switch (payload.route as HelperRoute) {
      case "editor.open":
        return this.openEditorPrompt(payload, lifetime);
      default:
        throw new Error(`Unsupported Git helper route: ${String(payload.route)}`);
    }
  }

  respondAskpass(args: unknown): void {
    const parsed = validateArgs(AskpassRespondArgsSchema, args);
    const pending = this.requirePending(parsed.promptId, "askpass");
    this.pending.delete(parsed.promptId);
    pending.resolve({ ok: true, value: parsed.value });
  }

  cancelAskpass(args: unknown): void {
    const parsed = validateArgs(GitHelperPromptIdArgsSchema, args);
    const pending = this.requirePending(parsed.promptId, "askpass");
    this.pending.delete(parsed.promptId);
    pending.resolve({ ok: false, error: "Credential prompt cancelled." });
  }

  openAgentAskpassPrompt(payload: AgentAskpassPromptPayload, respond: AgentAskpassResponder): void {
    if (this.pending.has(payload.requestId)) {
      throw new Error(`Inactive Git helper prompt id: ${payload.requestId}`);
    }

    const event = AskpassPromptSchema.parse({
      promptId: payload.requestId,
      workspaceId: payload.workspaceId || undefined,
      prompt: payload.prompt,
      field: classifyAskpassField(payload.prompt),
      service: extractPromptService(payload.prompt),
    }) satisfies AskpassPrompt;

    this.pending.set(payload.requestId, {
      kind: "askpass",
      promptId: payload.requestId,
      resolve: (response) => {
        const secret = response.ok ? (response.value ?? "") : null;
        void respond(secret).catch(() => {});
      },
    });
    this.broadcast("askpass", "prompt", event);
  }

  closeAgentAskpassPrompt(requestId: string): void {
    if (this.pending.get(requestId)?.kind !== "askpass") return;
    this.pending.delete(requestId);
    this.broadcast("askpass", "closed", { promptId: requestId });
  }

  async saveEditor(args: unknown): Promise<void> {
    const parsed = validateArgs(GitEditorSaveArgsSchema, args);
    const pending = this.requirePending(parsed.promptId, "editor");
    try {
      await fs.writeFile(pending.filePath, parsed.content, "utf8");
      pending.resolve({ ok: true, value: "" });
    } catch (error) {
      pending.resolve({ ok: false, error: errorMessage(error) });
      throw error;
    } finally {
      this.pending.delete(parsed.promptId);
    }
  }

  async cancelEditor(args: unknown): Promise<void> {
    const parsed = validateArgs(GitHelperPromptIdArgsSchema, args);
    const pending = this.requirePending(parsed.promptId, "editor");
    try {
      await fs.truncate(pending.filePath, 0).catch(() => {});
      pending.resolve({ ok: false, error: "Commit message edit cancelled." });
    } finally {
      this.pending.delete(parsed.promptId);
    }
  }

  private handleSocket(socket: net.Socket): void {
    let chunks: Buffer[] = [];
    let bytes = 0;
    let handled = false;
    const disconnected = new AbortController();
    this.awaitingRequests.set(socket, disconnected);
    socket.once("close", () => {
      chunks = [];
      this.awaitingRequests.delete(socket);
      disconnected.abort();
    });

    const reply = (response: HelperWireResponse): void => {
      this.awaitingRequests.delete(socket);
      if (!socket.destroyed && !disconnected.signal.aborted) {
        socket.end(`${JSON.stringify(response)}\n`);
      }
    };

    const finish = async (line: string): Promise<void> => {
      handled = true;
      chunks = [];
      try {
        const payload = JSON.parse(line) as HelperRequestPayload;
        const response = await this.handleHelperRequest(payload, {
          signal: disconnected.signal,
          promptOpened: () => this.awaitingRequests.delete(socket),
        });
        reply(response);
      } catch (error) {
        reply({ ok: false, error: errorMessage(error) });
      }
    };

    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      const newline = chunk.indexOf(0x0a);
      const part = newline < 0 ? chunk : chunk.subarray(0, newline);
      bytes += part.length;
      if (bytes > MAX_HELPER_REQUEST_BYTES) {
        handled = true;
        chunks = [];
        reply({
          ok: false,
          error: `Git helper request exceeds ${MAX_HELPER_REQUEST_BYTES} bytes.`,
        });
        return;
      }
      chunks.push(part);
      if (newline >= 0) void finish(Buffer.concat(chunks, bytes).toString("utf8"));
    });

    socket.once("end", () => {
      if (handled) {
        disconnected.abort();
        return;
      }
      const line = Buffer.concat(chunks, bytes).toString("utf8").trim();
      if (line) void finish(line);
    });

    socket.on("error", () => {});
  }

  private assertAuthorizedPayload(payload: HelperRequestPayload): void {
    if (payload.token !== this.token) {
      throw new Error("Git helper request rejected: invalid token.");
    }
    if (payload.promptId && !this.pending.has(payload.promptId)) {
      throw new Error("Git helper request rejected: inactive prompt id.");
    }
  }

  private async openEditorPrompt(
    payload: HelperRequestPayload,
    lifetime?: HelperRequestLifetime,
  ): Promise<HelperWireResponse> {
    if (!payload.filePath) throw new Error("Git editor helper request missing file path.");
    const { signal } = lifetime ?? {};
    if (signal?.aborted) return DISCONNECTED;
    const initialContent = await readEditorFile(payload.filePath, signal);
    if (signal?.aborted) return DISCONNECTED;
    const promptId = crypto.randomUUID();
    const event = GitEditorPromptSchema.parse({
      promptId,
      workspaceId: payload.workspaceId || undefined,
      kind: "commit-message",
      filePath: payload.filePath,
      initialContent,
    }) satisfies GitEditorPrompt;

    return new Promise((resolve) => {
      const closePrompt = () => {
        this.pending.delete(promptId);
        resolve(DISCONNECTED);
        this.broadcast("editor", "closed", { promptId });
      };
      signal?.addEventListener("abort", closePrompt, { once: true });
      this.pending.set(promptId, {
        kind: "editor",
        promptId,
        filePath: payload.filePath ?? "",
        resolve: (response) => {
          signal?.removeEventListener("abort", closePrompt);
          resolve(response);
        },
      });
      lifetime?.promptOpened?.();
      this.broadcast("editor", "prompt", event);
    });
  }

  private requirePending<K extends PendingPrompt["kind"]>(
    promptId: string,
    kind: K,
  ): Extract<PendingPrompt, { kind: K }> {
    const pending = this.pending.get(promptId);
    if (!pending || pending.kind !== kind) {
      throw new Error(`Inactive Git helper prompt id: ${promptId}`);
    }
    return pending as Extract<PendingPrompt, { kind: K }>;
  }
}

async function readEditorFile(filePath: string, signal?: AbortSignal): Promise<string> {
  const file = await fs.open(filePath, "r").catch(() => null);
  if (!file) return "";
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (!signal?.aborted && bytes <= MAX_EDITOR_FILE_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_EDITOR_FILE_BYTES + 1 - bytes));
      const read = await file.read(chunk).catch(() => null);
      if (!read || signal?.aborted) return "";
      if (read.bytesRead === 0) return Buffer.concat(chunks, bytes).toString("utf8");
      bytes += read.bytesRead;
      chunks.push(chunk.subarray(0, read.bytesRead));
    }
    if (signal?.aborted) return "";
    throw new Error(`Git editor file exceeds ${MAX_EDITOR_FILE_BYTES} bytes.`);
  } finally {
    await file.close();
  }
}

export function registerGitHelperIpcChannels(manager: GitHelpersIpcManager): void {
  register("askpass", {
    call: {
      respond: (args) => manager.respondAskpass(args),
      cancel: (args) => manager.cancelAskpass(args),
    },
    listen: { prompt: {} },
  });

  register("editor", {
    keepOnRendererClose: ["save"],
    call: {
      save: (args) => manager.saveEditor(args),
      cancel: (args) => manager.cancelEditor(args),
    },
    listen: { prompt: {}, closed: {} },
  });
}

export function buildGitHelpersEndpoint(
  userDataDir: string,
  platform: NodeJS.Platform = process.platform,
  pid = process.pid,
): GitHelpersEndpoint {
  if (platform === "win32") {
    return { kind: "pipe", path: `\\\\.\\pipe\\nexus-helpers-${pid}` };
  }

  return {
    kind: "unix",
    dir: userDataDir,
    path: path.join(userDataDir, `nexus-helpers-${pid}.sock`),
  };
}

export async function prepareGitHelpersEndpoint(options: {
  readonly userDataDir: string;
  readonly platform?: NodeJS.Platform;
  readonly pid?: number;
}): Promise<GitHelpersEndpoint> {
  const endpoint = buildGitHelpersEndpoint(
    options.userDataDir,
    options.platform ?? process.platform,
    options.pid ?? process.pid,
  );
  if (endpoint.kind === "pipe") return endpoint;

  await fs.mkdir(options.userDataDir, { recursive: true, mode: 0o700 });
  await fs.chmod(options.userDataDir, 0o700).catch(() => {});
  await fs.mkdir(endpoint.dir ?? options.userDataDir, { recursive: true, mode: 0o700 });
  if (endpoint.dir) {
    await fs.chmod(endpoint.dir, 0o700).catch(() => {});
  }
  await fs.unlink(endpoint.path).catch(() => {});
  return endpoint;
}

export function classifyAskpassField(prompt: string): AskpassPrompt["field"] {
  if (/passphrase/i.test(prompt)) return "passphrase";
  if (/password/i.test(prompt)) return "password";
  if (/username/i.test(prompt)) return "username";
  return "text";
}

function extractPromptService(prompt: string): string | undefined {
  const match = prompt.match(/for ['"]?([^'":]+:\/\/[^'"]+)['"]?/i);
  return match?.[1];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
