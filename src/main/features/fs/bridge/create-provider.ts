import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import type { AgentChannel } from "../../../infra/agent/channel";
import { AgentFsProvider } from "./agent-provider";
import { LocalFsProvider } from "./local-provider";
import { SshFsProvider } from "./ssh-provider";
import type { FsProvider } from "./provider";

/**
 * Creates the filesystem provider that matches a workspace location.
 */
export function createFsProvider(meta: WorkspaceMeta, channel?: AgentChannel): FsProvider {
  if (meta.location.kind === "local") {
    return new LocalFsProvider(meta.location.rootPath);
  }
  if (meta.location.kind === "wsl") {
    return new AgentFsProvider("wsl", channel, {
      notWiredMessage: "wsl fs provider: channel not yet wired",
    });
  }

  return new SshFsProvider(meta.location, channel);
}
