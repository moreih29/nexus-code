/**
 * The TCP ports the programs in each workspace's terminals listen on, as the
 * workspace's agent finds them (pty.listeningPorts), for the status bar and
 * the task switcher.
 *
 * Looking costs a process listing, about 60 ms on macOS, so a workspace is
 * looked at only while there is something to see: when one of its terminals
 * starts printing after a quiet spell and once more as that settles, as the
 * ActivityTracker looks at a terminal's program, then every few seconds
 * while its terminals keep printing or it has ports, so a server that stops
 * drops out. A quiet workspace with none is not looked at.
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

/** Asks a workspace's agent for its ports. */
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
  looking: boolean;
  /** Something asked for a look while one was under way. */
  again: boolean;
  /** Output started after a quiet spell: look once more as it settles. */
  settle: boolean;
  /** The last look failed: wait for output after a quiet spell to try again. */
  failed: boolean;
}

export class PortWatcher {
  private readonly lastOutput = new Map<string, number>();
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
        // Replayed output is old output shown again.
        if (replay) return;
        this.noteOutput(workspaceId, tabId);
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

  dispose(): void {
    this.disposed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const watch of this.watches.values()) clearTimeout(watch.timer);
    this.watches.clear();
    this.lastOutput.clear();
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
    } else if (!watch.failed && watch.timer === undefined && !watch.looking) {
      // Output that never paused, after the looks it started had stopped.
      this.schedule(workspaceId, watch, this.timing.busyPollMs);
    }
  }

  private dropTab({ workspaceId, tabId }: { workspaceId: string; tabId: string }): void {
    this.lastOutput.delete(`${workspaceId}:${tabId}`);
    const watch = this.watches.get(workspaceId);
    if (!watch?.ports.some((port) => port.tabId === tabId)) return;
    this.update(
      workspaceId,
      watch,
      watch.ports.filter((port) => port.tabId !== tabId),
    );
    this.retireIfDone(workspaceId, watch);
  }

  private stop(workspaceId: string): void {
    const watch = this.watches.get(workspaceId);
    if (!watch) return;
    clearTimeout(watch.timer);
    watch.timer = undefined;
    watch.settle = false;
    watch.again = false;
    this.update(workspaceId, watch, []);
    this.retireIfDone(workspaceId, watch);
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
        failed: false,
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

  private async look(workspaceId: string, watch: Watch): Promise<void> {
    watch.looking = true;
    let ports: ListeningPort[];
    try {
      ports = await this.lookup(workspaceId);
      watch.failed = false;
    } catch (error) {
      // An agent from before pty.listeningPorts, or one whose connection
      // dropped: there is nothing to show until the next look.
      log.debug(`looking at ${workspaceId}'s ports failed: ${(error as Error).message}`);
      ports = [];
      watch.failed = true;
    }
    watch.looking = false;
    if (this.disposed || this.watches.get(workspaceId) !== watch) return;
    this.update(workspaceId, watch, ports);

    if (watch.again) {
      watch.again = false;
      this.schedule(workspaceId, watch, 0);
    } else if (watch.settle) {
      watch.settle = false;
      this.schedule(workspaceId, watch, this.timing.settleMs);
    } else if (watch.failed) {
      // Wait for output after a quiet spell.
    } else if (this.now() - watch.lastOutputAt < this.timing.busyPollMs) {
      this.schedule(workspaceId, watch, this.timing.busyPollMs);
    } else if (watch.ports.length > 0) {
      this.schedule(workspaceId, watch, this.timing.portsPollMs);
    }
    this.retireIfDone(workspaceId, watch);
  }

  /** Forgets a workspace with nothing to show and nothing to look at. */
  private retireIfDone(workspaceId: string, watch: Watch): void {
    if (watch.ports.length === 0 && watch.timer === undefined && !watch.looking && !watch.failed) {
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
