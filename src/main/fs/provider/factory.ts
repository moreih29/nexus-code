import type { WorkspaceMeta } from "../../../shared/types/workspace";
import type { SshChannel } from "../../agent/ssh-channel";
import { LocalFsProvider } from "./local/local-fs-provider";
import { SshFsProvider } from "./ssh/ssh-fs-provider";
import type { FsReadProvider } from "./types";

/**
 * Creates the read provider that matches a workspace location.
 */
export function createFsProvider(meta: WorkspaceMeta, channel?: SshChannel): FsReadProvider {
  if (meta.location.kind === "local") {
    return new LocalFsProvider(meta.location.rootPath);
  }

  return new SshFsProvider(meta.location, channel);
}
