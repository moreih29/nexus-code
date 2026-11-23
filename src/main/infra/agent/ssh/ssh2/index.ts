import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Duplex } from "node:stream";
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

export function usesSsh2Client(env: NodeJS.ProcessEnv = process.env): boolean {
  const chosen = env.NEXUS_SSH_CLIENT;
  if (chosen === "ssh2") return true;
  if (chosen === "openssh") return false;
  return isWindows();
}

class SharedConnection {
  private current: Promise<Ssh2Connection> | null = null;
  private readonly lifetime = new AbortController();

  constructor(
    private readonly target: SshTarget,
    private readonly promptHandler: SshAuthPromptHandler | null,
    private readonly dependencies: ConnectSsh2Dependencies,
  ) {}

  client(): Promise<Client> {
    if (this.lifetime.signal.aborted) return Promise.reject(this.lifetime.signal.reason);
    if (this.current === null) {
      const signal = this.dependencies.signal
        ? AbortSignal.any([this.dependencies.signal, this.lifetime.signal])
        : this.lifetime.signal;
      const opening = connectSsh2(this.target, this.promptHandler, {
        ...this.dependencies,
        signal,
      });
      this.current = opening;
      opening.then(
        (connection) => {
          connection.client.on("close", () => {
            if (this.current === opening) this.current = null;
          });
          if (signal.aborted) connection.end();
        },
        () => {
          if (this.current === opening) this.current = null;
        },
      );
    }
    return this.current.then((connection) => connection.client);
  }

  dispose(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
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
  const own = new SharedConnection(
    { ...parseDestination(line.destination), port: line.port, identityFile: line.identityFile },
    null,
    {},
  );
  const process = start(own.client());
  process.once("close", () => own.dispose());
  return asChildProcess(process);
}

export interface Ssh2Forwarder {
  open(host: string, port: number): Promise<Duplex>;
  dispose(): void;
}

export function createSsh2Forwarder(
  target: SshTarget,
  controlPath: string | undefined,
): Ssh2Forwarder {
  const named = controlPath !== undefined ? shared.get(controlPath) : undefined;
  const own = named === undefined ? new SharedConnection(target, null, {}) : null;
  const connection = named ?? (own as SharedConnection);
  return {
    async open(host, port) {
      const client = await connection.client();
      return new Promise((resolve, reject) => {
        client.forwardOut("127.0.0.1", 0, host, port, (error, stream) => {
          if (error) reject(error);
          else resolve(stream);
        });
      });
    },
    dispose() {
      own?.dispose();
    },
  };
}

function asChildProcess(
  process: Ssh2CommandProcess | Ssh2SftpProcess,
): ChildProcessWithoutNullStreams {
  return process as unknown as ChildProcessWithoutNullStreams;
}
