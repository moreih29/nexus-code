/**
 * Local port forwarding over a workspace's SSH connection: a port on this
 * machine's 127.0.0.1 that reaches a port on the SSH host's localhost.
 *
 * - OpenSSH with a ControlMaster: the master forwards (`ssh -O forward -L`),
 *   and `-O cancel` stops it. The forward goes with the master.
 * - OpenSSH without one (key-only auth): an ssh of its own forwards. Its
 *   remote command reads stdin, so it ends when the app does, even a crashed
 *   one.
 * - ssh2 (Windows): a listener here pipes each connection into a channel
 *   (`forwardOut`) on the shared connection, or on one of its own.
 *
 * The far end is the host's `localhost`, which sshd resolves: a dev server
 * may listen on 127.0.0.1 or on ::1 alone.
 */

import net from "node:net";
import type { Duplex } from "node:stream";
import { defaultSpawnSsh, type SpawnSshProcess } from "./master";
import { createSsh2Forwarder, type Ssh2Forwarder, usesSsh2Client } from "./ssh2";

/** Where a workspace's SSH connection goes, and the master it shares, if any. */
export interface SshForwardTarget {
  readonly host: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly controlPath?: string;
}

/** An SSH workspace's host and its connection as it is now. */
export interface SshForwarding {
  readonly host: string;
  /** Connecting or reconnecting: a forward waits for it. */
  readonly connecting: boolean;
  /** The connection to forward over; null while not connected. */
  readonly target: SshForwardTarget | null;
}

/** One forward, from 127.0.0.1:localPort here to localhost:remotePort on the host. */
export interface SshTunnel {
  readonly localPort: number;
  readonly remotePort: number;
  /** The master it was set up on; a new master has none of the old one's forwards. */
  readonly controlPath: string | undefined;
  /** False once closed, or once an ssh of its own has exited. */
  alive(): boolean;
  /** Settles when the forward ends, closed or not. */
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export interface SshTunnelDependencies {
  readonly spawn?: SpawnSshProcess;
  readonly ssh2?: boolean;
  readonly createSsh2Forwarder?: typeof createSsh2Forwarder;
  /** How long an ssh of its own may take to connect. */
  readonly readyTimeoutMs?: number;
}

/** The far end every forward reaches. */
const REMOTE_HOST = "localhost";

/** What the ssh of its own prints once its forward listens. */
const READY_LINE = "nexus-forward-ready";

const DEFAULT_READY_TIMEOUT_MS = 30_000;

/** `-L`'s argument: this machine's 127.0.0.1 only. */
export function forwardSpec(localPort: number, remotePort: number): string {
  return `127.0.0.1:${localPort}:${REMOTE_HOST}:${remotePort}`;
}

function destination(target: SshForwardTarget): string {
  return target.user ? `${target.user}@${target.host}` : target.host;
}

function connectionArgs(target: SshForwardTarget): string[] {
  const args: string[] = [];
  if (target.port !== undefined) args.push("-p", String(target.port));
  if (target.identityFile) args.push("-i", target.identityFile);
  return args;
}

/** Asks a ControlMaster to start (`forward`) or stop (`cancel`) a forward. */
export function buildSshMuxForwardArgs(
  target: SshForwardTarget & { readonly controlPath: string },
  operation: "forward" | "cancel",
  localPort: number,
  remotePort: number,
): string[] {
  return [
    "-S",
    target.controlPath,
    "-O",
    operation,
    "-L",
    forwardSpec(localPort, remotePort),
    ...connectionArgs(target),
    "--",
    destination(target),
  ];
}

/** An ssh of its own that forwards and runs a command that waits on stdin. */
export function buildSshOwnForwardArgs(
  target: SshForwardTarget,
  localPort: number,
  remotePort: number,
): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=3",
    "-L",
    forwardSpec(localPort, remotePort),
    ...connectionArgs(target),
    "--",
    destination(target),
    // ssh binds the forward before it opens the session, so the line means
    // the forward listens; cat ends when the app closes its stdin.
    `echo ${READY_LINE}; exec cat >/dev/null`,
  ];
}

/** Starts forwarding 127.0.0.1:localPort here to the host's localhost:remotePort. */
export async function openSshTunnel(
  target: SshForwardTarget,
  localPort: number,
  remotePort: number,
  dependencies: SshTunnelDependencies = {},
): Promise<SshTunnel> {
  if (dependencies.ssh2 ?? usesSsh2Client()) {
    const forwarder = (dependencies.createSsh2Forwarder ?? createSsh2Forwarder)(
      target,
      target.controlPath,
    );
    try {
      return await listenAndForward(forwarder, target.controlPath, localPort, remotePort);
    } catch (error) {
      forwarder.dispose();
      throw error;
    }
  }
  const spawn = dependencies.spawn ?? defaultSpawnSsh;
  const { controlPath } = target;
  if (controlPath !== undefined) {
    await runSsh(
      spawn,
      buildSshMuxForwardArgs({ ...target, controlPath }, "forward", localPort, remotePort),
    );
    let closed = false;
    const ended = settler();
    return {
      localPort,
      remotePort,
      controlPath,
      alive: () => !closed,
      closed: ended.promise,
      async close() {
        if (closed) return;
        closed = true;
        // The master may be gone, and its forwards with it.
        await runSsh(
          spawn,
          buildSshMuxForwardArgs({ ...target, controlPath }, "cancel", localPort, remotePort),
        ).catch(() => undefined);
        ended.settle();
      },
    };
  }
  return ownSsh(
    spawn,
    target,
    localPort,
    remotePort,
    dependencies.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
  );
}

/** Runs an ssh that exits once done; rejects with its stderr when it fails. */
function runSsh(spawn: SpawnSshProcess, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, {});
    child.stdin.end();
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdout.resume();
    child.once("error", reject);
    child.once("close", (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error(lastLine(stderr) || `ssh exited with ${code}`));
    });
  });
}

function settler(): { promise: Promise<void>; settle: () => void } {
  let settle: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "";
}

function ownSsh(
  spawn: SpawnSshProcess,
  target: SshForwardTarget,
  localPort: number,
  remotePort: number,
  readyTimeoutMs: number,
): Promise<SshTunnel> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", buildSshOwnForwardArgs(target, localPort, remotePort), {});
    let exited = false;
    const ended = settler();
    let ready = false;
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      fail(new Error(`ssh did not forward port ${remotePort} in time`));
      child.kill();
    }, readyTimeoutMs);
    timer.unref?.();
    const fail = (error: Error) => {
      if (ready) return;
      ready = true;
      clearTimeout(timer);
      reject(error);
    };
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (ready) return;
      stdout += chunk.toString("utf8");
      if (!stdout.includes(READY_LINE)) return;
      ready = true;
      clearTimeout(timer);
      resolve({
        localPort,
        remotePort,
        controlPath: undefined,
        alive: () => !exited,
        closed: ended.promise,
        close: () =>
          new Promise<void>((done) => {
            if (exited) return done();
            child.once("close", () => done());
            child.stdin.end();
            child.kill();
          }),
      });
    });
    child.once("error", (error) => fail(error));
    child.once("close", (code: number | null) => {
      exited = true;
      ended.settle();
      fail(new Error(lastLine(stderr) || `ssh exited with ${code}`));
    });
  });
}

/** A listener here whose connections each get a channel to the far end. */
function listenAndForward(
  forwarder: Ssh2Forwarder,
  controlPath: string | undefined,
  localPort: number,
  remotePort: number,
): Promise<SshTunnel> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    forwarder.open(REMOTE_HOST, remotePort).then(
      (channel: Duplex) => {
        channel.on("error", () => undefined);
        if (socket.destroyed) {
          channel.destroy();
          return;
        }
        socket.pipe(channel).pipe(socket);
        socket.once("close", () => channel.destroy());
        channel.once("close", () => socket.destroy());
      },
      () => socket.destroy(),
    );
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: localPort, exclusive: true }, () => {
      server.off("error", reject);
      server.on("error", () => undefined);
      let closed = false;
      const ended = settler();
      resolve({
        localPort,
        remotePort,
        controlPath,
        alive: () => !closed,
        closed: ended.promise,
        close: () =>
          new Promise<void>((done) => {
            if (closed) return done();
            closed = true;
            for (const socket of sockets) socket.destroy();
            forwarder.dispose();
            server.close(() => {
              ended.settle();
              done();
            });
          }),
      });
    });
  });
}
