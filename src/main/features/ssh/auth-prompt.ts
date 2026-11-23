import {
  SshAuthCancelArgsSchema,
  type SshAuthPrompt,
  SshAuthPromptSchema,
  SshAuthRespondArgsSchema,
  type SshAuthResponse,
} from "../../../shared/ssh/auth-prompt";
import { AuthCancelledError } from "../../infra/agent/ssh/auth";
import { register, validateArgs } from "../../infra/ipc-router";

export { AuthCancelledError } from "../../infra/agent/ssh/auth";

type BroadcastFn = (channelName: string, event: string, args: unknown) => void;

interface PendingSshAuthPrompt {
  readonly promptId: string;
  readonly prompt: SshAuthPrompt;
  readonly resolve: (response: SshAuthResponse) => void;
  readonly reject: (error: AuthCancelledError) => void;
}

export class SshAuthPromptHub {
  private readonly broadcast: BroadcastFn;
  private readonly pending = new Map<string, PendingSshAuthPrompt>();

  constructor(broadcast: BroadcastFn) {
    this.broadcast = broadcast;
  }

  request(prompt: SshAuthPrompt, signal?: AbortSignal): Promise<SshAuthResponse> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const parsed = SshAuthPromptSchema.parse(prompt);
    if (this.pending.has(parsed.promptId)) {
      throw new Error(`Duplicate SSH authentication prompt id: ${parsed.promptId}`);
    }

    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(parsed.promptId);
        reject(signal?.reason);
        this.broadcast("sshAuth", "dismissed", { promptId: parsed.promptId });
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(parsed.promptId, {
        promptId: parsed.promptId,
        prompt: parsed,
        resolve: (response) => {
          signal?.removeEventListener("abort", abort);
          resolve(response);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
      this.broadcast("sshAuth", "prompt", parsed);
    });
  }

  listPending(): SshAuthPrompt[] {
    return [...this.pending.values()].map((entry) => entry.prompt);
  }

  respond(args: unknown): void {
    const parsed = validateArgs(SshAuthRespondArgsSchema, args);
    const pending = this.pending.get(parsed.promptId);
    if (!pending) return;

    this.pending.delete(parsed.promptId);
    pending.resolve(parsed);
  }

  cancel(args: unknown): void {
    const parsed = validateArgs(SshAuthCancelArgsSchema, args);
    const pending = this.pending.get(parsed.promptId);
    if (!pending) return;

    this.pending.delete(parsed.promptId);
    pending.reject(new AuthCancelledError(parsed.promptId));
  }
}

export function registerSshAuthPromptIpcChannels(hub: SshAuthPromptHub): void {
  register("sshAuth", {
    call: {
      respond: (args) => hub.respond(args),
      cancel: (args) => hub.cancel(args),
      pending: () => hub.listPending(),
    },
    listen: { prompt: {}, dismissed: {} },
  });
}
