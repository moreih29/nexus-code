/**
 * The in-process ssh2 client, in place of OpenSSH's binaries on Windows.
 *
 * Win32-OpenSSH has no ControlMaster, so each `ssh` the app runs would open
 * and authenticate a connection of its own: about ten to open a workspace,
 * each asking for the password. On Windows the app runs ssh2 instead.
 * authenticateSsh2Master opens one connection and names it with a control
 * path, as a ControlMaster's socket would be named; spawnSsh2Process runs
 * every later `ssh -S <path> … command` as a command on that connection.
 * A connection that drops is opened again on the next command, answering its
 * prompts through the same handler (whose cache holds the password).
 *
 * NEXUS_SSH_CLIENT=ssh2 or =openssh picks the client on any platform.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Client } from "ssh2";
import { isWindows } from "../../../platform";
import type { SshAuthPromptHandler } from "../auth-pty";
import type { SshControlMaster, SshMasterOptions } from "../master";
import type { SshTarget } from "./config";
import { type ConnectSsh2Dependencies, connectSsh2, type Ssh2Connection } from "./connect";
import {
  parseDestination,
  parseSshCommandLine,
  Ssh2CommandProcess,
  Ssh2SftpProcess,
} from "./process";

/** Whether `ssh` runs through ssh2 rather than OpenSSH's binaries. */
export function usesSsh2Client(env: NodeJS.ProcessEnv = process.env): boolean {
  const chosen = env.NEXUS_SSH_CLIENT;
  if (chosen === "ssh2") return true;
  if (chosen === "openssh") return false;
  return isWindows();
}

/** One authenticated connection that commands share, opened again when it drops. */
class SharedConnection {
  private current: Promise<Ssh2Connection> | null = null;
  private disposed = false;

  constructor(
    private readonly target: SshTarget,
    private readonly promptHandler: SshAuthPromptHandler | null,
    private readonly dependencies: ConnectSsh2Dependencies,
  ) {}

  client(): Promise<Client> {
    if (this.disposed) return Promise.reject(new Error("the ssh2 connection was closed"));
    if (this.current === null) {
      const opening = connectSsh2(this.target, this.promptHandler, this.dependencies);
      this.current = opening;
      opening.then(
        (connection) => {
          connection.client.on("close", () => {
            if (this.current === opening) this.current = null;
          });
          if (this.disposed) connection.end();
        },
        () => {
          if (this.current === opening) this.current = null;
        },
      );
    }
    return this.current.then((connection) => connection.client);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const current = this.current;
    this.current = null;
    void current?.then(
      (connection) => connection.end(),
      () => undefined,
    );
  }
}

const shared = new Map<string, SharedConnection>();
let masterSequence = 0;

/**
 * Opens the connection later commands share, answering its prompts through
 * `promptHandler`: the ssh2 counterpart of authenticateSshControlMaster.
 */
export async function authenticateSsh2Master(
  options: Omit<SshMasterOptions, "remoteCommand">,
  promptHandler: SshAuthPromptHandler,
  dependencies: ConnectSsh2Dependencies = {},
): Promise<SshControlMaster> {
  const target = {
    host: options.host,
    user: options.user,
    port: options.port,
    identityFile: options.identityFile,
  };
  const connection = new SharedConnection(target, promptHandler, dependencies);
  try {
    await connection.client();
  } catch (error) {
    connection.dispose();
    throw error;
  }
  masterSequence += 1;
  const controlPath = `ssh2:${masterSequence}:${options.user ? `${options.user}@` : ""}${options.host}`;
  shared.set(controlPath, connection);
  return {
    controlPath,
    host: options.host,
    user: options.user,
    port: options.port,
    identityFile: options.identityFile,
    dispose() {
      if (shared.get(controlPath) !== connection) return;
      shared.delete(controlPath);
      connection.dispose();
    },
  };
}

/**
 * Runs an `ssh` or `sftp` command line on ssh2, as master.ts and the
 * bootstrap spawn OpenSSH's. A control path (`-S`, or `-o ControlPath=` for
 * sftp) runs the command on that path's connection; without one the command
 * gets a connection of its own and, as BatchMode, asks nothing.
 */
export function spawnSsh2Process(
  command: string,
  args: readonly string[],
): ChildProcessWithoutNullStreams {
  const line = parseSshCommandLine(args);
  const connection = line.controlPath !== undefined ? shared.get(line.controlPath) : undefined;
  if (line.controlCommand === "exit") {
    if (connection !== undefined && line.controlPath !== undefined) {
      shared.delete(line.controlPath);
      connection.dispose();
    }
    return asChildProcess(new Ssh2CommandProcess(Promise.reject(new Error("exit")), ""));
  }

  const start = (client: Promise<Client>) =>
    command === "sftp"
      ? new Ssh2SftpProcess(client)
      : new Ssh2CommandProcess(client, line.remoteCommand ?? "");
  if (connection !== undefined) return asChildProcess(start(connection.client()));
  // As `ssh -S <gone socket> -o ControlMaster=no` does, connect directly.
  const own = new SharedConnection(
    { ...parseDestination(line.destination), port: line.port, identityFile: line.identityFile },
    null,
    {},
  );
  const process = start(own.client());
  process.once("close", () => own.dispose());
  return asChildProcess(process);
}

function asChildProcess(
  process: Ssh2CommandProcess | Ssh2SftpProcess,
): ChildProcessWithoutNullStreams {
  return process as unknown as ChildProcessWithoutNullStreams;
}
