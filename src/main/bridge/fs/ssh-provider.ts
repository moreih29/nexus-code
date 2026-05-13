import type { WorkspaceLocation } from "../../../shared/types/workspace";
import type { SshChannel } from "../../agent/ssh-channel";
import { AgentFsProvider } from "./agent-provider";

type SshWorkspaceLocation = Extract<WorkspaceLocation, { kind: "ssh" }>;

const SSH_FS_PROVIDER_NOT_WIRED = "ssh fs provider: channel not yet wired";

/**
 * SSH filesystem provider. The actual fs implementation still lives in the
 * agent; this class only preserves the SSH-specific constructor used by callers.
 */
export class SshFsProvider extends AgentFsProvider {
  constructor(
    readonly location: SshWorkspaceLocation,
    channel?: SshChannel,
  ) {
    super("ssh", channel, { notWiredMessage: SSH_FS_PROVIDER_NOT_WIRED });
  }
}
