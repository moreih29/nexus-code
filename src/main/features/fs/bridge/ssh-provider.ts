import type { WorkspaceLocation } from "../../../../shared/types/workspace";
import type { SshChannel } from "../../../infra/agent/ssh/channel";
import { AgentFsProvider } from "./agent-provider";

type SshWorkspaceLocation = Extract<WorkspaceLocation, { kind: "ssh" }>;

const SSH_FS_PROVIDER_NOT_WIRED = "ssh fs provider: channel not yet wired";

export class SshFsProvider extends AgentFsProvider {
  constructor(
    readonly location: SshWorkspaceLocation,
    channel?: SshChannel,
  ) {
    super("ssh", channel, { notWiredMessage: SSH_FS_PROVIDER_NOT_WIRED });
  }
}
