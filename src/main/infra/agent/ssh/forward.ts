import net from "node:net";
import type { Duplex } from "node:stream";
import { defaultSpawnSsh, type SpawnSshProcess, sshDestination } from "./master";
import { createSsh2Forwarder, type Ssh2Forwarder, usesSsh2Client } from "./ssh2";

export interface SshForwardTarget {
  readonly host: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly controlPath?: string;
}

export interface SshForwarding {
  readonly host: string;
  readonly connecting: boolean;
  readonly target: SshForwardTarget | null;
}

export interface SshTunnel {
  readonly localPort: number;
  readonly remotePort: number;
  readonly controlPath: string | undefined;
  alive(): boolean;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export interface SshTunnelDependencies {
  readonly spawn?: SpawnSshProcess;
  readonly ssh2?: boolean;
  readonly createSsh2Forwarder?: typeof createSsh2Forwarder;
  readonly readyTimeoutMs?: number;
}

const REMOTE_HOST = "localhost";

const READY_LINE = "nexus-forward-ready";

const DEFAULT_READY_TIMEOUT_MS = 30_000;

export function forwardSpec(localPort: number, remotePort: number): string {
  return `127.0.0.1:${localPort}:${REMOTE_HOST}:${remotePort}`;
}

function connectionArgs(target: SshForwardTarget): string[] {
  const args: string[] = [];
  if (target.port !== undefined) args.push("-p", String(target.port));
  if (target.identityFile) args.push("-i", target.identityFile);
  return args;
}

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
    sshDestination(target),
  ];
}

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
    sshDestination(target),
    `echo ${READY_LINE}; exec cat >/dev/null`,
  ];
}

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
