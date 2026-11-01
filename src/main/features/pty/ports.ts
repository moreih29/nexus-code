/**
 * The TCP ports the programs in each workspace's terminals listen on, as the
 * workspace's agent finds them (pty.listeningPorts), for the status bar and
 * the task switcher.
 *
 * Looking costs a process listing, about 40 ms on macOS and twice that with
 * a program running, so a workspace is looked at only while there is
 * something to see: when one of its terminals starts printing after a
 * quiet spell and once more as that settles, as the ActivityTracker looks
 * at a terminal's program, then every few seconds while its terminals keep
 * printing or it has ports, so a server that stops drops out. A terminal
 * attached again, after the app restarted or its connection came back, is
 * looked at once for the servers that kept running quietly. A quiet
 * workspace with none is not looked at.
 */

import { createLogger } from "../../../shared/log/main";
import type { ListeningPort, WorkspacePorts } from "../../../shared/pty/ports";
import { BUSY_WINDOW_MS } from "../../../shared/sessions/agent-state";
import { type ActivitySource, PROGRAM_SETTLE_MS } from "../cli/activity";

const log = createLogger("ports");

/** How often a workspace is looked at while its terminals print. */
export const BUSY_POLL_MS = 5_000;
/** How often a quiet workspace with ports is looked at, for a server that stops. */
export const PORTS_POLL_MS = 10_000;

/**
 * Asks a workspace's agent for its ports. It throws when it cannot tell, as
 * for a workspace that is not connected, which it must not connect.
 */
export type PortLookup = (workspaceId: string) => Promise<ListeningPort[]>;

export interface PortTiming {
  settleMs: number;
  busyPollMs: number;
  portsPollMs: number;
}

const DEFAULT_TIMING: PortTiming = {
  settleMs: PROGRAM_SETTLE_MS,
  busyPollMs: BUSY_POLL_MS,
  portsPollMs: PORTS_POLL_MS,
};

interface Watch {
  ports: ListeningPort[];
  /** When one of the workspace's terminals last printed. */
  lastOutputAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  dueAt: number;
  /** A scheduled look is under way. */
  looking: boolean;
  /** Something asked for a look while one was under way. */
  again: boolean;
  /** Output started after a quiet spell: look once more as it settles. */
  settle: boolean;
  /** The looks started so far; each is numbered by it. */
  started: number;
  /**
   * The number of the look whose answer is shown. An answer from a look
   * started before it, or before a tab's ports were dropped, is stale.
   */
  shown: number;
  /** Looks under way, scheduled or not. */
  pending: number;
}

export class PortWatcher {
  private readonly lastOutput = new Map<string, number>();
  /** When each workspace's terminals last replayed their output. */
  private readonly lastReplay = new Map<string, number>();
  private readonly watches = new Map<string, Watch>();
  private readonly disposers: Array<() => void> = [];
  private disposed = false;

  constructor(
    source: ActivitySource,
    private readonly lookup: PortLookup,
    private readonly onChange: (entry: WorkspacePorts) => void,
    private readonly now: () => number = Date.now,
    private readonly timing: PortTiming = DEFAULT_TIMING,
  ) {
    this.disposers.push(
      source.on("data", (args) => {
        const { workspaceId, tabId, replay } = args as {
          workspaceId: string;
          tabId: string;
          replay?: boolean;
        };
        // Replayed output is old output shown again, by a terminal attached again.
        if (replay) this.noteReplay(workspaceId);
        else this.noteOutput(workspaceId, tabId);
      }),
      // A server dies with its terminal.
      source.on("exit", (args) => this.dropTab(args as { workspaceId: string; tabId: string })),
      source.on("expired", (args) => this.dropTab(args as { workspaceId: string; tabId: string })),
      // The connection is down: there is no asking until output comes back.
      source.on("held", (args) => this.stop((args as { workspaceId: string }).workspaceId)),
    );
  }

  /** The workspace's ports, in port order. */
  get(workspaceId: string): readonly ListeningPort[] {
    return this.watches.get(workspaceId)?.ports ?? [];
  }

  /** Every workspace that has ports. */
  snapshot(): WorkspacePorts[] {
    const entries: WorkspacePorts[] = [];
    for (const [workspaceId, watch] of this.watches) {
      if (watch.ports.length > 0) entries.push({ workspaceId, ports: watch.ports });
    }
    return entries;
  }

  /**
   * Looks at the workspace now, for a command that needs its ports as they
   * are rather than as the last look saw them, and shows what it finds
   * unless a newer look's answer is shown by then. A failed look throws,
   * leaving the ports shown as they were.
   */
  async refresh(workspaceId: string): Promise<readonly ListeningPort[]> {
    const watch = this.watch(workspaceId);
    try {
      return await this.ask(workspaceId, watch);
    } finally {
      if (!this.disposed && this.watches.get(workspaceId) === watch) {
        // Keep looking, for a server that stops.
        if (watch.ports.length > 0) this.schedule(workspaceId, watch, this.timing.portsPollMs);
        this.retireIfDone(workspaceId, watch);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const watch of this.watches.values()) clearTimeout(watch.timer);
    this.watches.clear();
    this.lastOutput.clear();
    this.lastReplay.clear();
  }

  private noteOutput(workspaceId: string, tabId: string): void {
    const at = this.now();
    const key = `${workspaceId}:${tabId}`;
    const previous = this.lastOutput.get(key);
    this.lastOutput.set(key, at);
    const watch = this.watch(workspaceId);
    watch.lastOutputAt = at;
    if (previous === undefined || at - previous >= BUSY_WINDOW_MS) {
      watch.settle = true;
      this.schedule(workspaceId, watch, 0);
    } else if (watch.timer === undefined && !watch.looking) {
      // Output that never paused, after the looks it started had stopped.
      this.schedule(workspaceId, watch, this.timing.busyPollMs);
    }
  }

  /** Looks once when a workspace's terminals start replaying, for servers listening quietly. */
  private noteReplay(workspaceId: string): void {
    const at = this.now();
    const previous = this.lastReplay.get(workspaceId);
    this.lastReplay.set(workspaceId, at);
    if (previous !== undefined && at - previous < BUSY_WINDOW_MS) return;
    this.schedule(workspaceId, this.watch(workspaceId), 0);
  }

  private dropTab({ workspaceId, tabId }: { workspaceId: string; tabId: string }): void {
    this.lastOutput.delete(`${workspaceId}:${tabId}`);
    const watch = this.watches.get(workspaceId);
    if (!watch) return;
    // A look under way may still see the tab's servers.
    watch.shown = watch.started;
    if (!watch.ports.some((port) => port.tabId === tabId)) return;
    this.update(
      workspaceId,
      watch,
      watch.ports.filter((port) => port.tabId !== tabId),
    );
    this.retireIfDone(workspaceId, watch);
  }

  /** Clears the workspace's ports and forgets it, a look under way included. */
  private stop(workspaceId: string): void {
    const watch = this.watches.get(workspaceId);
    if (!watch) return;
    clearTimeout(watch.timer);
    this.watches.delete(workspaceId);
    if (watch.ports.length > 0) this.onChange({ workspaceId, ports: [] });
  }

  private watch(workspaceId: string): Watch {
    let watch = this.watches.get(workspaceId);
    if (!watch) {
      watch = {
        ports: [],
        lastOutputAt: 0,
        timer: undefined,
        dueAt: 0,
        looking: false,
        again: false,
        settle: false,
        started: 0,
        shown: 0,
        pending: 0,
      };
      this.watches.set(workspaceId, watch);
    }
    return watch;
  }

  /** Looks at the workspace in `delayMs`, unless a look is due sooner. */
  private schedule(workspaceId: string, watch: Watch, delayMs: number): void {
    if (watch.looking) {
      if (delayMs === 0) watch.again = true;
      return;
    }
    const dueAt = this.now() + delayMs;
    if (watch.timer !== undefined && watch.dueAt <= dueAt) return;
    clearTimeout(watch.timer);
    watch.dueAt = dueAt;
    watch.timer = setTimeout(() => {
      watch.timer = undefined;
      void this.look(workspaceId, watch);
    }, delayMs);
  }

  /**
   * Asks for the workspace's ports and shows the answer, unless the watch
   * has ended or a newer answer is shown. Throws what the lookup throws.
   */
  private async ask(workspaceId: string, watch: Watch): Promise<ListeningPort[]> {
    const number = ++watch.started;
    watch.pending++;
    try {
      const ports = await this.lookup(workspaceId);
      if (!this.disposed && this.watches.get(workspaceId) === watch && number > watch.shown) {
        watch.shown = number;
        this.update(workspaceId, watch, ports);
      }
      return ports;
    } finally {
      watch.pending--;
    }
  }

  private async look(workspaceId: string, watch: Watch): Promise<void> {
    watch.looking = true;
    try {
      await this.ask(workspaceId, watch);
    } catch (error) {
      // An agent from before pty.listeningPorts, a workspace not connected,
      // or a dropped connection: what was seen last stays until a look
      // says otherwise or the connection is held.
      log.debug(`looking at ${workspaceId}'s ports failed: ${(error as Error).message}`);
    }
    watch.looking = false;
    if (this.disposed || this.watches.get(workspaceId) !== watch) return;

    if (watch.again) {
      watch.again = false;
      this.schedule(workspaceId, watch, 0);
    } else if (watch.settle) {
      watch.settle = false;
      this.schedule(workspaceId, watch, this.timing.settleMs);
    } else if (this.now() - watch.lastOutputAt < this.timing.busyPollMs) {
      this.schedule(workspaceId, watch, this.timing.busyPollMs);
    } else if (watch.ports.length > 0) {
      this.schedule(workspaceId, watch, this.timing.portsPollMs);
    }
    this.retireIfDone(workspaceId, watch);
  }

  /** Forgets a workspace with nothing to show and nothing to look at. */
  private retireIfDone(workspaceId: string, watch: Watch): void {
    if (watch.ports.length === 0 && watch.timer === undefined && watch.pending === 0) {
      this.watches.delete(workspaceId);
    }
  }

  private update(workspaceId: string, watch: Watch, ports: ListeningPort[]): void {
    if (samePorts(watch.ports, ports)) return;
    watch.ports = ports;
    this.onChange({ workspaceId, ports });
  }
}

function samePorts(a: readonly ListeningPort[], b: readonly ListeningPort[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (port, i) =>
        port.port === b[i].port &&
        port.pid === b[i].pid &&
        port.process === b[i].process &&
        port.tabId === b[i].tabId,
    )
  );
}
