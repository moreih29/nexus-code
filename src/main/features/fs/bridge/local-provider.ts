import { createLocalChannel, type CreateLocalChannelOptions } from "../../../infra/agent/local-channel";
import {
  resolveLocalAgentCommand,
  type LocalAgentCommand,
} from "../../../infra/agent/local-agent-resolver";
import type { AgentChannel } from "../../../infra/agent/channel";
import { AgentFsProvider } from "./agent-provider";

export type CreateLocalFsChannel = (options: CreateLocalChannelOptions) => AgentChannel;
export type ResolveLocalAgentCommand = () => LocalAgentCommand;

export interface LocalFsProviderOptions {
  readonly createChannel?: CreateLocalFsChannel;
  readonly resolveCommand?: ResolveLocalAgentCommand;
}

/**
 * Local filesystem provider that delegates all workspace fs operations to a
 * local agent child process.
 */
export class LocalFsProvider extends AgentFsProvider {
  private readonly clearOwnedChannel: () => void;

  constructor(rootPath: string, options: LocalFsProviderOptions = {}) {
    let channel: AgentChannel | null = null;
    super(
      "local",
      () => {
        if (!channel) {
          const command = (options.resolveCommand ?? resolveLocalAgentCommand)();
          channel = (options.createChannel ?? createLocalChannel)({
            ...command,
            rootPath,
          });
        }
        return channel;
      },
      { disposeChannel: true },
    );
    this.clearOwnedChannel = () => {
      channel = null;
    };
  }

  override dispose(): void {
    super.dispose();
    this.clearOwnedChannel();
  }
}
