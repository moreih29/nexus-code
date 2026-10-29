/**
 * A remote command on an ssh2 connection, shaped as the `ssh` process that
 * would have run it.
 *
 * Callers spawn `ssh … -- destination command` and read its stdio, exit code
 * and stderr, then classify OpenSSH's stderr lines (stderr-patterns.ts). This
 * process gives them the same: the command's stdio, its exit code, 255 when
 * the connection fails, and that failure written to stderr in OpenSSH's words
 * so it is classified as OpenSSH's would be.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Client, ClientChannel, SFTPWrapper } from "ssh2";
import type { SshError } from "../../pipe";

/** OpenSSH's exit status for a connection or authentication failure. */
export const SSH_FAILURE_EXIT = 255;

/** The parts of an `ssh` command line the ssh2 client acts on. */
export interface SshCommandLine {
  readonly controlPath?: string;
  readonly destination: string;
  readonly port?: number;
  readonly identityFile?: string;
  /** Absent for `-N` or `-O`, which run no remote command. */
  readonly remoteCommand?: string;
  /** `-O exit`: stop the shared connection. */
  readonly controlCommand?: string;
}

/** Reads the `ssh` command lines master.ts and the bootstrap build. */
export function parseSshCommandLine(args: readonly string[]): SshCommandLine {
  let controlPath: string | undefined;
  let port: number | undefined;
  let identityFile: string | undefined;
  let controlCommand: string | undefined;
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      index += 1;
      break;
    }
    if (arg === "-S") controlPath = args[++index];
    // sftp takes the port as -P.
    else if (arg === "-p" || arg === "-P") port = Number(args[++index]);
    else if (arg === "-i") identityFile = args[++index];
    else if (arg === "-O") controlCommand = args[++index];
    else if (arg === "-o") {
      const option = args[++index] ?? "";
      const control = /^ControlPath=(.*)$/i.exec(option);
      if (control) controlPath = control[1];
    } else if (!arg.startsWith("-")) break;
  }
  const destination = args[index] ?? "";
  const rest = args.slice(index + 1);
  return {
    controlPath,
    destination,
    port,
    identityFile,
    remoteCommand: rest.length > 0 ? rest.join(" ") : undefined,
    controlCommand,
  };
}

/** Splits `user@host` into its parts. */
export function parseDestination(destination: string): { host: string; user?: string } {
  const at = destination.lastIndexOf("@");
  return at >= 0
    ? { host: destination.slice(at + 1), user: destination.slice(0, at) || undefined }
    : { host: destination };
}

let pidSequence = 0;

/** The child process callers expect of `ssh` or `sftp`, with nothing run yet. */
abstract class Ssh2Process extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** A label for logs; no local process runs. */
  readonly pid = -++pidSequence;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  protected finished = false;

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.finished) return false;
    this.killed = true;
    this.stop(typeof signal === "string" ? signal : "SIGTERM");
    return true;
  }

  protected abstract stop(signal: NodeJS.Signals): void;

  protected failConnection(error: unknown): void {
    if (this.finished) return;
    this.stderr.write(`${describeFailure(error)}\n`);
    this.finish(SSH_FAILURE_EXIT, null);
  }

  protected finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.finished) return;
    this.finished = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, signal);
    // "close" follows the stdio, as a child process's does.
    setImmediate(() => this.emit("close", code, signal));
  }
}

/** The `ssh` child process callers expect, over an ssh2 exec channel. */
export class Ssh2CommandProcess extends Ssh2Process {
  private channel: ClientChannel | null = null;

  /**
   * Runs `command` once `client` resolves; a rejection is reported as ssh
   * reports a failed connection.
   */
  constructor(client: Promise<Client>, command: string) {
    super();
    client.then(
      (connected) => this.exec(connected, command),
      (error: unknown) => this.failConnection(error),
    );
  }

  protected stop(signal: NodeJS.Signals): void {
    if (this.channel === null) {
      this.finish(null, signal);
      return;
    }
    // As the ssh process ending would: the remote session closes.
    this.channel.close();
  }

  private exec(client: Client, command: string): void {
    if (this.killed) return;
    try {
      client.exec(command, (error, channel) => {
        if (error) {
          this.failConnection(error);
          return;
        }
        if (this.killed) {
          channel.close();
          this.finish(null, "SIGTERM");
          return;
        }
        this.attach(channel);
      });
    } catch (error) {
      this.failConnection(error);
    }
  }

  private attach(channel: ClientChannel): void {
    this.channel = channel;
    this.stdin.pipe(channel);
    channel.pipe(this.stdout);
    channel.stderr.pipe(this.stderr);
    let code: number | null = null;
    let signal: NodeJS.Signals | null = null;
    channel.on("exit", (exitCode: number | null, exitSignal?: string) => {
      code = exitCode;
      signal = exitSignal ? (`SIG${exitSignal}` as NodeJS.Signals) : null;
    });
    channel.on("close", () => {
      // A channel closed with no exit status went down with its connection.
      this.finish(code === null && signal === null ? SSH_FAILURE_EXIT : code, signal);
    });
  }
}

/**
 * The `sftp` child process callers expect: it reads the batch the bootstrap
 * writes to stdin (`put "local" "remote"`, `chmod 755 "remote"`) and runs it
 * over the connection's SFTP channel, exiting 1 on the first failure as
 * `sftp -b` does.
 */
export class Ssh2SftpProcess extends Ssh2Process {
  private sftp: SFTPWrapper | null = null;

  constructor(client: Promise<Client>) {
    super();
    const chunks: Buffer[] = [];
    this.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    this.stdin.on("end", () => {
      client.then(
        (connected) => this.run(connected, Buffer.concat(chunks).toString("utf8")),
        (error: unknown) => this.failConnection(error),
      );
    });
  }

  protected stop(signal: NodeJS.Signals): void {
    this.sftp?.end();
    this.finish(null, signal);
  }

  private run(client: Client, batch: string): void {
    if (this.killed) return;
    let commands: string[][];
    try {
      commands = batch
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map(parseSftpLine);
    } catch (error) {
      this.failBatch(error);
      return;
    }
    client.sftp((error, sftp) => {
      if (error) {
        this.failConnection(error);
        return;
      }
      this.sftp = sftp;
      runSftpCommands(sftp, commands).then(
        () => {
          sftp.end();
          this.finish(0, null);
        },
        (failure: unknown) => {
          sftp.end();
          this.failBatch(failure);
        },
      );
    });
  }

  private failBatch(error: unknown): void {
    if (this.finished) return;
    this.stderr.write(`sftp: ${error instanceof Error ? error.message : String(error)}\n`);
    this.finish(1, null);
  }
}

/** Splits one batch line into words, each bare or "double-quoted". */
export function parseSftpLine(line: string): string[] {
  const words: string[] = [];
  for (const match of line.matchAll(/"([^"]*)"|(\S+)/g)) words.push(match[1] ?? match[2]);
  return words;
}

async function runSftpCommands(sftp: SFTPWrapper, commands: readonly string[][]): Promise<void> {
  for (const [verb, ...args] of commands) {
    if (verb === "put" && args.length === 2) {
      await new Promise<void>((resolve, reject) => {
        sftp.fastPut(args[0], args[1], (error) => (error ? reject(error) : resolve()));
      });
    } else if (verb === "chmod" && args.length === 2 && /^[0-7]{3,4}$/.test(args[0])) {
      await new Promise<void>((resolve, reject) => {
        sftp.chmod(args[1], Number.parseInt(args[0], 8), (error) =>
          error ? reject(error) : resolve(),
        );
      });
    } else {
      throw new Error(`unsupported batch command: ${[verb, ...args].join(" ")}`);
    }
  }
}

/** A connection failure in the words OpenSSH would print. */
export function describeFailure(error: unknown): string {
  const code = error instanceof Error ? (error as SshError).code : undefined;
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
  const detail = cause instanceof Error ? cause.message : String(cause);
  if (/host key verification failed/i.test(detail)) return detail;
  if (code === "ssh.auth-failed") return `Permission denied (ssh2: ${detail}).`;
  if (code === "ssh.connect-failed")
    return `ssh: connect to host failed: Connection closed by ssh2 (${detail})`;
  return `ssh2: ${detail}`;
}
