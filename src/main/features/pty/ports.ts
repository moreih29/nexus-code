import { createLogger } from "../../../shared/log/main";
import type { ListeningPort, WorkspacePorts } from "../../../shared/pty/ports";
import { BUSY_WINDOW_MS } from "../../../shared/sessions/agent-state";
import { type ActivitySource, PROGRAM_SETTLE_MS } from "../cli/activity";

const log = createLogger("ports");

export const BUSY_POLL_MS = 5_000;
export const PORTS_POLL_MS = 10_000;

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
  lastOutputAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  dueAt: number;
  looking: boolean;
  again: boolean;
  settle: boolean;
  started: number;
  shown: number;
  pending: number;
}

export class PortWatcher {
  private readonly lastOutput = new Map<string, number>();
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
        if (replay) this.noteReplay(workspaceId);
        else this.noteOutput(workspaceId, tabId);
      }),
      source.on("exit", (args) => this.dropTab(args as { workspaceId: string; tabId: string })),
      source.on("expired", (args) => this.dropTab(args as { workspaceId: string; tabId: string })),
      source.on("held", (args) => this.stop((args as { workspaceId: string }).workspaceId)),
    );
  }

  get(workspaceId: string): readonly ListeningPort[] {
    return this.watches.get(workspaceId)?.ports ?? [];
  }

  snapshot(): WorkspacePorts[] {
    const entries: WorkspacePorts[] = [];
    for (const [workspaceId, watch] of this.watches) {
      if (watch.ports.length > 0) entries.push({ workspaceId, ports: watch.ports });
    }
    return entries;
  }

  async refresh(workspaceId: string): Promise<readonly ListeningPort[]> {
    const watch = this.watch(workspaceId);
    try {
      return await this.ask(workspaceId, watch);
    } finally {
      if (!this.disposed && this.watches.get(workspaceId) === watch) {
        if (watch.ports.length > 0) this.schedule(workspaceId, watch, this.timing.portsPollMs);
        this.retireIfDone(workspaceId, watch);
      }
    }
  }

  forgetWorkspace(workspaceId: string): void {
    this.lastReplay.delete(workspaceId);
    const prefix = `${workspaceId}:`;
    for (const key of this.lastOutput.keys()) {
      if (key.startsWith(prefix)) this.lastOutput.delete(key);
    }
    this.stop(workspaceId);
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
      this.schedule(workspaceId, watch, this.timing.busyPollMs);
    }
  }

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
    watch.shown = watch.started;
    if (!watch.ports.some((port) => port.tabId === tabId)) return;
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
