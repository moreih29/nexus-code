import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ipcContract } from "../../../shared/ipc-contract";
import { parseSshConfig, type SshConfigHost } from "../../ssh-config";
import { register, validateArgs } from "../router";

const c = ipcContract.ssh.call;

/**
 * Registers SSH-related main-process IPC handlers.
 */
export function registerSshChannel(configPath = path.join(os.homedir(), ".ssh", "config")): void {
  register("ssh", {
    call: {
      listConfigHosts: listConfigHostsHandler(configPath),
    },
    listen: {},
  });
}

/**
 * Builds the listConfigHosts IPC handler with an injectable config path.
 */
export function listConfigHostsHandler(
  configPath = path.join(os.homedir(), ".ssh", "config"),
): (args: unknown) => Promise<SshConfigHost[]> {
  return async (args: unknown): Promise<SshConfigHost[]> => {
    validateArgs(c.listConfigHosts.args, args);
    return readConfigHosts(configPath);
  };
}

/**
 * Reads an ssh config file and returns concrete Host entries.
 */
async function readConfigHosts(configPath: string): Promise<SshConfigHost[]> {
  try {
    return parseSshConfig(await readFile(configPath, "utf8"));
  } catch (error) {
    if (isMissingOrPermissionError(error)) {
      return [];
    }
    throw error;
  }
}

/**
 * Identifies missing or unreadable ssh config files.
 */
function isMissingOrPermissionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM";
}
