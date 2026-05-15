/**
 * Unified IPC/socket manager for Git askpass and editor helpers.
 *
 * Git cannot call Electron IPC directly, so child helper scripts connect to a
 * local socket/named pipe with a boot token. The manager validates the token,
 * broadcasts renderer prompts, and resolves the helper only when a matching
 * active prompt id responds.
 */
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
} from "../../../../../shared/types/git";
import { register, validateArgs } from "../../../../infra/ipc-router";
import { type GitHelperConnection, setDefaultGitHelperConnection } from "./launcher";

type BroadcastFn = (channelName: string, event: string, args: unknown) => void;

type HelperRoute = "editor.open";

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

export type AgentAskpassResponder = (secret: string) => Promise<void>;

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

/**
 * Owns the helper server lifecycle, prompt nonce table, and renderer response
 * handlers for both askpass and commit-message editor requests.
 */
export class GitHelpersIpcManager {
  private readonly userDataDir: string;
  private readonly broadcast: BroadcastFn;
  private readonly platform: NodeJS.Platform;
  private readonly pid: number;
  private readonly token: string;
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

  /**
   * Starts the socket/named-pipe server and publishes its connection values to
   * the helper launcher singleton used by GitRepository operations.
   */
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

  /**
   * Stops the helper server and rejects all outstanding helper requests so Git
   * subprocesses do not hang during app shutdown.
   */
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
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (endpoint?.kind === "unix") {
      await fs.unlink(endpoint.path).catch(() => {});
    }
  }

  /**
   * Returns the current socket path and token. Call `start()` first so the
   * endpoint exists.
   */
  connection(): GitHelperConnection {
    if (!this.endpoint) {
      throw new Error("Git helper manager has not started.");
    }
    return { socketPath: this.endpoint.path, token: this.token };
  }

  /**
   * Processes one decoded helper payload. Tests call this directly to exercise
   * token and active-prompt validation without opening an OS socket.
   */
  async handleHelperRequest(payload: HelperRequestPayload): Promise<HelperWireResponse> {
    this.assertAuthorizedPayload(payload);

    switch (payload.route as HelperRoute) {
      case "editor.open":
        return this.openEditorPrompt(payload);
      default:
        throw new Error(`Unsupported Git helper route: ${String(payload.route)}`);
    }
  }

  /**
   * Resolves the active askpass prompt with the renderer-provided value.
   */
  respondAskpass(args: unknown): void {
    const parsed = validateArgs(AskpassRespondArgsSchema, args);
    const pending = this.requirePending(parsed.promptId, "askpass");
    this.pending.delete(parsed.promptId);
    pending.resolve({ ok: true, value: parsed.value });
  }

  /**
   * Cancels the active askpass prompt; the helper exits non-zero and Git
   * reports an authentication failure.
   */
  cancelAskpass(args: unknown): void {
    const parsed = validateArgs(GitHelperPromptIdArgsSchema, args);
    const pending = this.requirePending(parsed.promptId, "askpass");
    this.pending.delete(parsed.promptId);
    pending.resolve({ ok: false, error: "Credential prompt cancelled." });
  }

  /**
   * Reuses the renderer askpass UI for prompts that originate from the Go
   * agent-host helper instead of the legacy Electron-host helper socket.
   */
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
        const secret = response.ok ? (response.value ?? "") : "";
        void respond(secret).catch(() => {});
      },
    });
    this.broadcast("askpass", "prompt", event);
  }

  /**
   * Writes the edited commit message file and lets Git continue.
   */
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

  /**
   * Truncates the commit message file and aborts Git's editor flow.
   */
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

  /**
   * Reads a single JSON-line request from a helper process and writes a
   * JSON-line response. Each helper invocation uses one short-lived socket.
   */
  private handleSocket(socket: net.Socket): void {
    let buffer = "";
    let handled = false;
    socket.setEncoding("utf8");

    const finish = async (line: string): Promise<void> => {
      if (handled) return;
      handled = true;
      try {
        const payload = JSON.parse(line) as HelperRequestPayload;
        const response = await this.handleHelperRequest(payload);
        socket.end(`${JSON.stringify(response)}\n`);
      } catch (error) {
        socket.end(`${JSON.stringify({ ok: false, error: errorMessage(error) })}\n`);
      }
    };

    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        void finish(buffer.slice(0, newline));
      }
    });

    socket.on("end", () => {
      if (buffer.trim().length > 0) {
        void finish(buffer.trim());
      }
    });

    socket.on("error", () => {});
  }

  /**
   * Checks the boot token and, when a prompt id is supplied, verifies the id is
   * currently active before any route-specific work runs.
   */
  private assertAuthorizedPayload(payload: HelperRequestPayload): void {
    if (payload.token !== this.token) {
      throw new Error("Git helper request rejected: invalid token.");
    }
    if (payload.promptId && !this.pending.has(payload.promptId)) {
      throw new Error("Git helper request rejected: inactive prompt id.");
    }
  }

  /**
   * Broadcasts a commit-message editor prompt after reading Git's temporary
   * message file. The renderer's save/cancel handler owns the final write.
   */
  private async openEditorPrompt(payload: HelperRequestPayload): Promise<HelperWireResponse> {
    if (!payload.filePath) throw new Error("Git editor helper request missing file path.");
    const initialContent = await fs.readFile(payload.filePath, "utf8").catch(() => "");
    const promptId = crypto.randomUUID();
    const event = GitEditorPromptSchema.parse({
      promptId,
      workspaceId: payload.workspaceId || undefined,
      kind: "commit-message",
      filePath: payload.filePath,
      initialContent,
    }) satisfies GitEditorPrompt;

    return new Promise((resolve) => {
      this.pending.set(promptId, {
        kind: "editor",
        promptId,
        filePath: payload.filePath ?? "",
        resolve,
      });
      this.broadcast("editor", "prompt", event);
    });
  }

  /**
   * Returns the active prompt after verifying it belongs to the expected
   * helper family.
   */
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

/**
 * Registers renderer-response IPC methods for askpass and editor prompts.
 */
export function registerGitHelperIpcChannels(manager: GitHelpersIpcManager): void {
  register("askpass", {
    call: {
      respond: (args) => manager.respondAskpass(args),
      cancel: (args) => manager.cancelAskpass(args),
    },
    listen: { prompt: {} },
  });

  register("editor", {
    call: {
      save: (args) => manager.saveEditor(args),
      cancel: (args) => manager.cancelEditor(args),
    },
    listen: { prompt: {} },
  });
}

/**
 * Builds the OS-specific helper endpoint without touching the filesystem.
 */
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

/**
 * Creates a private Unix socket directory or returns a Windows named pipe
 * endpoint. Unix socket files are unlinked before listening to clear stale
 * process exits.
 */
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

/**
 * Categorizes a Git/SSH prompt so the renderer can mask secrets.
 */
export function classifyAskpassField(prompt: string): AskpassPrompt["field"] {
  if (/passphrase/i.test(prompt)) return "passphrase";
  if (/password/i.test(prompt)) return "password";
  if (/username/i.test(prompt)) return "username";
  return "text";
}

/**
 * Extracts a compact service label from common Git HTTPS prompts.
 */
function extractPromptService(prompt: string): string | undefined {
  const match = prompt.match(/for ['"]?([^'":]+:\/\/[^'"]+)['"]?/i);
  return match?.[1];
}

/**
 * Converts unknown failures into short helper protocol error text.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
