import {
  type SshAuthPrompt,
  SshAuthPromptSchema,
  type SshAuthResponse,
  SshAuthCancelArgsSchema,
  SshAuthRespondArgsSchema,
} from "../../../../shared/types/ssh-auth-prompt";
import { register, validateArgs } from "../../ipc/router";

type BroadcastFn = (channelName: string, event: string, args: unknown) => void;

interface PendingSshAuthPrompt {
  readonly promptId: string;
  readonly resolve: (response: SshAuthResponse) => void;
  readonly reject: (error: AuthCancelledError) => void;
}

/** Error raised when the renderer cancels an active SSH authentication prompt. */
export class AuthCancelledError extends Error {
  constructor(promptId: string) {
    super(`SSH authentication prompt cancelled: ${promptId}`);
    this.name = "AuthCancelledError";
  }
}

/**
 * Coordinates main-initiated SSH authentication prompts with renderer replies.
 * Requests are keyed by `promptId`, so unrelated IPC request ids cannot resolve
 * or cancel an SSH prompt started by the transport layer.
 */
export class SshAuthPromptHub {
  private readonly broadcast: BroadcastFn;
  private readonly pending = new Map<string, PendingSshAuthPrompt>();

  constructor(broadcast: BroadcastFn) {
    this.broadcast = broadcast;
  }

  /** Broadcasts a validated prompt and waits for the renderer response. */
  request(prompt: SshAuthPrompt): Promise<SshAuthResponse> {
    const parsed = SshAuthPromptSchema.parse(prompt);
    if (this.pending.has(parsed.promptId)) {
      throw new Error(`Duplicate SSH authentication prompt id: ${parsed.promptId}`);
    }

    return new Promise((resolve, reject) => {
      this.pending.set(parsed.promptId, {
        promptId: parsed.promptId,
        resolve,
        reject,
      });
      this.broadcast("sshAuth", "prompt", parsed);
    });
  }

  /** Resolves the matching active prompt; stale or duplicate responses are ignored. */
  respond(args: unknown): void {
    const parsed = validateArgs(SshAuthRespondArgsSchema, args);
    const pending = this.pending.get(parsed.promptId);
    if (!pending) return;

    this.pending.delete(parsed.promptId);
    pending.resolve(parsed);
  }

  /** Rejects the matching active prompt; stale or duplicate cancels are ignored. */
  cancel(args: unknown): void {
    const parsed = validateArgs(SshAuthCancelArgsSchema, args);
    const pending = this.pending.get(parsed.promptId);
    if (!pending) return;

    this.pending.delete(parsed.promptId);
    pending.reject(new AuthCancelledError(parsed.promptId));
  }
}

/** Registers renderer response handlers for SSH authentication prompts. */
export function registerSshAuthPromptIpcChannels(hub: SshAuthPromptHub): void {
  register("sshAuth", {
    call: {
      respond: (args) => hub.respond(args),
      cancel: (args) => hub.cancel(args),
    },
    listen: { prompt: {} },
  });
}
