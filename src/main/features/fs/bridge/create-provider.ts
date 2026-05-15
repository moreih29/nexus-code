import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import type { SshChannel } from "../../../infra/agent/ssh/channel";
import { LocalFsProvider } from "./local-provider";
import { SshFsProvider } from "./ssh-provider";
import type { FsProvider } from "./provider";

/**
 * Creates the filesystem provider that matches a workspace location.
 */
export function createFsProvider(meta: WorkspaceMeta, channel?: SshChannel): FsProvider {
  if (meta.location.kind === "local") {
    return new LocalFsProvider(meta.location.rootPath);
  }

  return new SshFsProvider(meta.location, channel);
}
