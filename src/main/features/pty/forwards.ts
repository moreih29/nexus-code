/**
 * The ports of SSH workspaces' hosts forwarded to this machine, on demand:
 * when a local address is opened from an SSH workspace, or by hand.
 *
 * A forward listens on 127.0.0.1 here, on the host's port number when that
 * is free here and on another one when not. The mapping is kept per
 * workspace: when the workspace disconnects its forwards close, and when it
 * connects again they are set up again on the same local ports (a new
 * ControlMaster has none of the old one's), so pages opened on them work
 * again. The mapping is saved, so after a restart the forwards come back
 * when the workspace connects, and a browser tab left on a forward's local
 * port reaches the same remote port. A workspace removed takes its
 * forwards with it.
 */

import net from "node:net";
import { createLogger } from "../../../shared/log/main";
import {
  loopbackPort,
  type PortForward,
  type WorkspaceForwards,
  withPort,
} from "../../../shared/pty/ports";
import type { WorkspaceConnectionEventStatus } from "../../../shared/types/workspace";
import {
  openSshTunnel,
  type SshForwarding,
  type SshForwardTarget,
  type SshTunnel,
} from "../../infra/agent/ssh/forward";

const log = createLogger("forwards");

/** Why a forward could not be set up. */
export type ForwardFailure = "not-ssh" | "not-connected" | "failed";

export class ForwardError extends Error {
  constructor(
    readonly kind: ForwardFailure,
    message: string,
    /** What went wrong, without what was being done: ssh's own words for "failed". */
    readonly reason: string = message,
  ) {
    super(message);
  }
}

/** A forward as it is saved: the ports at both ends. */
export interface SavedForward {
  readonly remotePort: number;
  readonly localPort: number;
}

export interface PortForwardsDependencies {
  /** Null for a workspace that is not on an SSH host. */
  ssh(workspaceId: string): SshForwarding | null;
  /** Told of a workspace's forwards each time they change. */
  broadcast(entry: WorkspaceForwards): void;
  /** The forwards saved before, set up again when their workspaces connect. */
  saved?: Readonly<Record<string, readonly SavedForward[]>>;
  /** Keeps a workspace's forwards; an empty list forgets them. */
  save?(workspaceId: string, forwards: SavedForward[]): void;
  openTunnel?: (
    target: SshForwardTarget,
    localPort: number,
    remotePort: number,
  ) => Promise<SshTunnel>;
  /** A port free here, `preferred` if it is. */
  pickPort?: (preferred: number) => Promise<number>;
  /** How long a forward waits for a workspace that is still connecting. */
  connectTimeoutMs?: number;
}

interface Forward {
  readonly remotePort: number;
  localPort: number;
  /** Set up once at least; kept while the workspace reconnects. */
  established: boolean;
  tunnel: SshTunnel | null;
  /** The set-up under way. */
  opening: Promise<SshTunnel> | null;
}

/** Statuses after which the workspace's forwards are closed. */
const CLOSING: ReadonlySet<WorkspaceConnectionEventStatus> = new Set([
  "disconnected",
  "error",
  "held-then-expired",
]);

const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;

export class PortForwards {
  private readonly workspaces = new Map<string, Map<number, Forward>>();
  private readonly connectWaiters = new Map<string, Set<() => void>>();
  private disposed = false;

  constructor(private readonly dependencies: PortForwardsDependencies) {
    for (const [workspaceId, saved] of Object.entries(dependencies.saved ?? {})) {
      const forwards = this.forwardsOf(workspaceId);
      for (const { remotePort, localPort } of saved) {
        forwards.set(remotePort, {
          remotePort,
          localPort,
          established: true,
          tunnel: null,
          opening: null,
        });
      }
    }
  }

  /** Every workspace that has forwards. */
  snapshot(): WorkspaceForwards[] {
    return [...this.workspaces.keys()].map((workspaceId) => this.entry(workspaceId));
  }

  list(workspaceId: string): PortForward[] {
    return this.entry(workspaceId).forwards;
  }

  /**
   * Forwards the host's `remotePort`, or answers the forward already there.
   * A workspace still connecting is waited for.
   */
  async forward(workspaceId: string, remotePort: number): Promise<PortForward> {
    if (this.dependencies.ssh(workspaceId) === null) {
      throw new ForwardError("not-ssh", "the workspace is not on an SSH host");
    }
    const forwards = this.forwardsOf(workspaceId);
    let forward = forwards.get(remotePort);
    if (forward?.tunnel?.alive()) return this.describe(forward);
    if (!forward) {
      forward = {
        remotePort,
        localPort: remotePort,
        established: false,
        tunnel: null,
        opening: null,
      };
      forwards.set(remotePort, forward);
    }
    try {
      await this.open(workspaceId, forward);
    } catch (error) {
      // A forward that never worked is not kept for later.
      if (forwards.get(remotePort) === forward && !forward.established) {
        forwards.delete(remotePort);
        this.changed(workspaceId);
      }
      throw error;
    }
    return this.describe(forward);
  }

  /** Stops forwarding the host's `remotePort`. */
  async stop(workspaceId: string, remotePort: number): Promise<void> {
    const forwards = this.workspaces.get(workspaceId);
    const forward = forwards?.get(remotePort);
    if (!forwards || !forward) return;
    forwards.delete(remotePort);
    if (forwards.size === 0) this.workspaces.delete(workspaceId);
    this.changed(workspaceId);
    await this.closeTunnel(forward);
  }

  /**
   * The URL to open for `url` in the workspace: a local address of an SSH
   * workspace goes to its forward, set up for it if need be. Any other URL,
   * and one already on a forward's local port, is as given.
   */
  async localUrl(workspaceId: string, url: string): Promise<string> {
    if (!this.rewrites(workspaceId, url)) return url;
    const port = loopbackPort(url) as number;
    // A forward's own local port, as a tab left there across a restart,
    // stands for the forward's remote one.
    const remotePort = this.byLocalPort(workspaceId, port)?.remotePort ?? port;
    const forward = await this.forward(workspaceId, remotePort);
    return forward.localPort === port ? url : withPort(url, forward.localPort);
  }

  /**
   * Whether `localUrl` would change or forward `url`; answered at once. A
   * URL on a forward's local port is the forward's already, as a page the
   * forward opened on another port and reloaded.
   */
  rewrites(workspaceId: string, url: string): boolean {
    const port = loopbackPort(url);
    if (port === null) return false;
    if (this.dependencies.ssh(workspaceId) === null) return false;
    // One not set up yet on this connection is set up first.
    return !this.byLocalPort(workspaceId, port)?.tunnel?.alive();
  }

  private byLocalPort(workspaceId: string, port: number): Forward | undefined {
    for (const forward of this.workspaces.get(workspaceId)?.values() ?? []) {
      if (forward.established && forward.localPort === port) return forward;
    }
    return undefined;
  }

  /** Follows the workspace's connection: closes forwards on a drop, restores them on connect. */
  connectionChanged(workspaceId: string, status: WorkspaceConnectionEventStatus): void {
    if (status === "connected" || CLOSING.has(status)) {
      const waiters = this.connectWaiters.get(workspaceId);
      this.connectWaiters.delete(workspaceId);
      for (const wake of waiters ?? []) wake();
    }
    const forwards = this.workspaces.get(workspaceId);
    if (!forwards) return;
    if (CLOSING.has(status)) {
      for (const forward of forwards.values()) void this.closeTunnel(forward);
      this.changed(workspaceId);
      return;
    }
    if (status !== "connected") return;
    for (const forward of forwards.values()) {
      void this.open(workspaceId, forward).catch((error: unknown) => {
        log.warn(`forward of port ${forward.remotePort} not restored: ${(error as Error).message}`);
      });
    }
  }

  /** The workspace is gone: its forwards close and are forgotten. */
  removed(workspaceId: string): void {
    const forwards = this.workspaces.get(workspaceId);
    this.workspaces.delete(workspaceId);
    if (!this.disposed && forwards) this.dependencies.save?.(workspaceId, []);
    for (const wake of this.connectWaiters.get(workspaceId) ?? []) wake();
    this.connectWaiters.delete(workspaceId);
    for (const forward of forwards?.values() ?? []) void this.closeTunnel(forward);
  }

  /** The app is quitting: the forwards close, and stay saved for the next start. */
  dispose(): void {
    this.disposed = true;
    for (const workspaceId of [...this.workspaces.keys()]) this.removed(workspaceId);
  }

  private forwardsOf(workspaceId: string): Map<number, Forward> {
    let forwards = this.workspaces.get(workspaceId);
    if (!forwards) {
      forwards = new Map();
      this.workspaces.set(workspaceId, forwards);
    }
    return forwards;
  }

  /**
   * Sets the forward up on the workspace's current connection, unless its
   * tunnel is alive on it already. One set-up at a time per forward.
   */
  private async open(workspaceId: string, forward: Forward): Promise<void> {
    while (forward.opening) await forward.opening.catch(() => undefined);
    const target = await this.connectedTarget(workspaceId);
    const { tunnel } = forward;
    if (tunnel?.alive() && tunnel.controlPath === target.controlPath) return;
    if (tunnel) await this.closeTunnel(forward);
    const opening = this.openTunnel(target, forward);
    forward.opening = opening;
    try {
      const opened = await opening;
      if (this.disposed || this.workspaces.get(workspaceId)?.get(forward.remotePort) !== forward) {
        // Stopped or removed meanwhile.
        void opened.close();
        return;
      }
      forward.tunnel = opened;
      forward.localPort = opened.localPort;
      forward.established = true;
      this.changed(workspaceId);
      // An ssh of its own can exit on its own, as when the network drops.
      void opened.closed.then(() => {
        if (forward.tunnel !== opened) return;
        forward.tunnel = null;
        this.changed(workspaceId);
      });
    } finally {
      if (forward.opening === opening) forward.opening = null;
    }
  }

  private async openTunnel(target: SshForwardTarget, forward: Forward): Promise<SshTunnel> {
    const pickPort = this.dependencies.pickPort ?? pickLocalPort;
    const openTunnel = this.dependencies.openTunnel ?? openSshTunnel;
    const localPort = await pickPort(forward.localPort);
    try {
      return await openTunnel(target, localPort, forward.remotePort);
    } catch (error) {
      const reason = (error as Error).message;
      throw new ForwardError(
        "failed",
        `could not forward port ${forward.remotePort}: ${reason}`,
        reason,
      );
    }
  }

  /** The workspace's connection, once it has connected. */
  private async connectedTarget(workspaceId: string): Promise<SshForwardTarget> {
    let ssh = this.dependencies.ssh(workspaceId);
    if (ssh && !ssh.target && ssh.connecting) {
      await this.whenConnectedOrClosed(workspaceId);
      ssh = this.dependencies.ssh(workspaceId);
    }
    if (!ssh) throw new ForwardError("not-ssh", "the workspace is not on an SSH host");
    if (!ssh.target) throw new ForwardError("not-connected", `${ssh.host} is not connected`);
    return ssh.target;
  }

  private whenConnectedOrClosed(workspaceId: string): Promise<void> {
    return new Promise((resolve) => {
      let waiters = this.connectWaiters.get(workspaceId);
      if (!waiters) {
        waiters = new Set();
        this.connectWaiters.set(workspaceId, waiters);
      }
      const wake = () => {
        clearTimeout(timer);
        waiters?.delete(wake);
        resolve();
      };
      const timer = setTimeout(
        wake,
        this.dependencies.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      );
      timer.unref?.();
      waiters.add(wake);
    });
  }

  private async closeTunnel(forward: Forward): Promise<void> {
    const { tunnel } = forward;
    forward.tunnel = null;
    if (!tunnel) return;
    try {
      await tunnel.close();
    } catch (error) {
      log.warn(`closing forward of port ${forward.remotePort}: ${(error as Error).message}`);
    }
  }

  private describe(forward: Forward): PortForward {
    return {
      remotePort: forward.remotePort,
      localPort: forward.localPort,
      active: forward.tunnel?.alive() ?? false,
    };
  }

  private entry(workspaceId: string): WorkspaceForwards {
    const forwards = [...(this.workspaces.get(workspaceId)?.values() ?? [])]
      .filter((forward) => forward.established)
      .sort((a, b) => a.remotePort - b.remotePort)
      .map((forward) => this.describe(forward));
    return { workspaceId, forwards };
  }

  private changed(workspaceId: string): void {
    if (this.disposed) return;
    const entry = this.entry(workspaceId);
    this.dependencies.broadcast(entry);
    this.dependencies.save?.(
      workspaceId,
      entry.forwards.map(({ remotePort, localPort }) => ({ remotePort, localPort })),
    );
  }
}

/** How many ports past the preferred one are tried before any free one. */
const NEARBY_PORTS = 20;

/**
 * A port free here on 127.0.0.1, and on ::1 too: a browser opening
 * localhost may try ::1 first, where another server could answer.
 */
export async function pickLocalPort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + NEARBY_PORTS && port <= 65_535; port += 1) {
    if (await isFree(port)) return port;
  }
  for (let tries = 0; tries < 5; tries += 1) {
    const port = await anyFreePort();
    if (await isFree(port)) return port;
  }
  throw new ForwardError("failed", "no free port here");
}

async function isFree(port: number): Promise<boolean> {
  return (await canListen(port, "127.0.0.1")) && (await canListen(port, "::1"));
}

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      // Without IPv6 there is nothing on ::1 to answer.
      resolve(host === "::1" && (error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT"));
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

function anyFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
