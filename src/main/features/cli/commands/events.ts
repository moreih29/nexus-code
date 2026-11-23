import type { CliSessionEvent } from "../../../../shared/cli/ui";
import { shortId } from "../../../../shared/util/short-id";
import { CliUsageError, exactArgs, parseDuration } from "../args";
import { type CliContext, type CliDevice, resolveWorkspace } from "../context";
import { oneLine, table } from "../format";
import { type CliCommand, output } from "../registry";
import {
  askDevice,
  DEVICE_FLAG,
  deviceFlag,
  deviceRef,
  listDevices,
  peerSessions,
  pickPeerWorkspace,
  resolveDevice,
} from "../remote";
import { MAX_WAIT_MS, WAIT_POLL_MS } from "../wait";

const DEFAULT_LIMIT = 100;

function agentOf(event: CliSessionEvent): string {
  return event.kind === "terminal" ? (event.agent ?? "?") : `${event.kind}-tab`;
}

function changeText(event: CliSessionEvent): string {
  const goal = !event.goal
    ? ""
    : event.goal.from === null
      ? `goal set (${event.goal.status})`
      : `goal ${event.goal.from} → ${event.goal.status}`;
  if (event.goal && event.from === event.to) return goal;
  const state = `${event.from ?? "new"} → ${event.to}`;
  return goal ? `${state}, ${goal}` : state;
}

function clockTime(at: number): string {
  return new Date(at).toTimeString().slice(0, 8);
}

async function readEvents(
  ctx: CliContext,
  since: number | undefined,
  limit: number,
  workspaceId: string | undefined,
): Promise<{ events: CliSessionEvent[]; cursor: number; more: boolean }> {
  const read = await ctx.services.ui("events.read", {
    ...(since !== undefined ? { since } : {}),
    limit: workspaceId === undefined ? limit : Number.MAX_SAFE_INTEGER,
  });
  if (workspaceId === undefined) return read;
  const ours = read.events.filter((event) => event.workspaceId === workspaceId);
  return since === undefined
    ? { events: ours.slice(-limit), cursor: read.cursor, more: false }
    : { events: ours.slice(0, limit), cursor: read.cursor, more: ours.length > limit };
}

const PEER_POLL_MS = 5_000;
const MAX_PEER_EVENTS = 500;

async function readPeerEvents(
  ctx: CliContext,
  device: CliDevice,
  since: number | undefined,
  limit: number,
  workspaceId: string | undefined,
  signal = ctx.signal,
): Promise<{ events: CliSessionEvent[]; cursor: number; more: boolean }> {
  const page = (after: number | undefined) =>
    askDevice(
      ctx,
      device,
      "events.read",
      {
        ...(after !== undefined ? { since: after } : {}),
        limit: workspaceId === undefined ? Math.min(limit, MAX_PEER_EVENTS) : MAX_PEER_EVENTS,
      },
      signal,
    );
  let read = await page(since);
  const tell = (event: (typeof read.events)[number]): CliSessionEvent => ({
    ...event,
    phase: event.to,
  });
  if (workspaceId === undefined) return { ...read, events: read.events.map(tell) };
  if (since === undefined) {
    const matching = read.events.filter((event) => event.workspaceId === workspaceId);
    return { events: matching.slice(-limit).map(tell), cursor: read.cursor, more: false };
  }

  const cursor = read.cursor;
  const events: CliSessionEvent[] = [];
  let after = since;
  for (;;) {
    const matching = read.events.filter(
      (event) => event.seq <= cursor && event.workspaceId === workspaceId,
    );
    const remaining = limit - events.length;
    events.push(...matching.slice(0, remaining).map(tell));
    const last = read.events.at(-1)?.seq;
    const more = read.more && last !== undefined && last < cursor;
    if (events.length === limit) {
      return { events, cursor, more: more || matching.length > remaining };
    }
    if (!more || last === after) return { events, cursor, more: false };
    after = last;
    read = await page(after);
  }
}

function eventCursors(value: unknown): Record<string, number> {
  if (value === undefined) return Object.create(null);
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw new CliUsageError("--cursors takes a JSON object of device ids and sequence numbers");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new CliUsageError("--cursors takes a JSON object");
  const entries = Object.entries(parsed);
  if (
    entries.some(
      ([id, seq]) => !id || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0,
    )
  )
    throw new CliUsageError("--cursors requires a nonnegative integer sequence per device");
  return Object.assign(Object.create(null), parsed);
}

async function beforeAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  let stop = () => {};
  const aborted = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason);
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

async function allDeviceEvents(
  ctx: CliContext,
  flags: Record<string, unknown>,
  limit: number,
  waitMs: number,
) {
  if (flags.since !== undefined || flags.workspace !== undefined)
    throw new CliUsageError("--device all takes --cursors and covers every workspace");
  const cursors = eventCursors(flags.cursors);
  const clock = ctx.services.clock;
  const started = clock.now();
  const deadline = started + waitMs;
  let devices: CliDevice[] = [];
  let local = { id: "local", name: "This computer" };
  let peerOffset = 0;

  async function batch() {
    const signal =
      waitMs > 0
        ? AbortSignal.any([
            AbortSignal.timeout(Math.max(1, Math.min(PEER_POLL_MS, deadline - clock.now()))),
            ...(ctx.signal ? [ctx.signal] : []),
          ])
        : ctx.signal;
    try {
      devices = await beforeAbort(listDevices(ctx), signal);
    } catch (error) {
      if (!signal?.aborted) throw error;
      return { events: [], errors: [], more: [] };
    }
    const self = devices.find((device) => device.self);
    if (self) local = deviceRef(self);
    const peers = devices.filter((device) => !device.self && device.online);
    const errors: { device: { id: string; name: string }; error: string }[] = [];
    const more: string[] = [];
    const events: (CliSessionEvent & { device: typeof local })[] = [];

    async function collect(device: typeof local, read: () => ReturnType<typeof readEvents>) {
      try {
        signal?.throwIfAborted();
        const page = await beforeAbort(read(), signal);
        cursors[device.id] = page.more
          ? (page.events.at(-1)?.seq ?? cursors[device.id] ?? 0)
          : page.cursor;
        if (page.more) more.push(device.id);
        events.push(...page.events.map((event) => ({ ...event, device })));
      } catch (error) {
        errors.push({ device, error: error instanceof Error ? error.message : String(error) });
      }
    }

    let index = 0;
    const readPeer = async () => {
      while (index < peers.length && !signal?.aborted) {
        const peer = peers[(peerOffset + index++) % peers.length];
        await collect(deviceRef(peer), () =>
          readPeerEvents(ctx, peer, cursors[peer.id], limit, undefined, signal),
        );
      }
    };
    await Promise.all([
      collect(local, () => readEvents(ctx, cursors[local.id], limit, undefined)),
      ...Array.from({ length: Math.min(4, peers.length) }, readPeer),
    ]);
    if (peers.length) peerOffset = (peerOffset + index) % peers.length;
    events.sort((a, b) => a.at - b.at || a.device.id.localeCompare(b.device.id) || a.seq - b.seq);
    return { events, errors, more };
  }

  let polledAt = clock.now();
  let result = await batch();
  while (!result.events.length && !result.more.length && !ctx.signal?.aborted) {
    const remaining = deadline - clock.now();
    if (remaining <= 0) break;
    const delay = Math.min(remaining, polledAt + PEER_POLL_MS - clock.now());
    if (delay > 0) await clock.sleep(delay);
    if (clock.now() >= deadline || ctx.signal?.aborted) break;
    polledAt = clock.now();
    result = await batch();
  }
  const offline = devices.filter((device) => !device.self && !device.online).map(deviceRef);
  const text = table(
    ["DEVICE", "SEQ", "TIME", "TAB", "CHANGE"],
    result.events.map((event) => [
      event.device.name,
      `#${event.seq}`,
      clockTime(event.at),
      event.title,
      changeText(event),
    ]),
  );
  const cursorText = `Cursors: ${JSON.stringify(cursors)}`;
  const details = [
    text || "No changes.",
    ...result.errors.map(({ device, error }) => `${device.name}: ${error}`),
    ...(offline.length ? [`${offline.length} device(s) offline.`] : []),
    cursorText,
    ...(result.more.length
      ? ["More changes are available. Run again with the returned cursors."]
      : []),
  ];
  return output(
    details.join("\n"),
    { ...result, cursors, offline },
    {
      records: [
        ...result.events,
        { type: "cursors", cursors, more: result.more, errors: result.errors, offline },
      ],
      ...(waitMs > 0 && !result.events.length ? { exitCode: 124 } : {}),
    },
  );
}

const events: CliCommand = {
  path: ["events"],
  summary: "Print the agent sessions' state changes in every workspace",
  details:
    "A change is a terminal's agent or a Claude or Codex tab going from one state to another\n" +
    "(working, asking, idle, completed, error, ...), appearing at work, or closed, with its last\n" +
    "answer or question; or a Claude or Codex tab's goal (/goal) set or changing status (active,\n" +
    "paused, met, ...). Each has a number (#seq): --since N prints those after #N, and --wait\n" +
    "waits for the next one when there is none yet, so a loop follows every session:\n" +
    "  nexus events --since N --wait 10m --jsonl\n" +
    "--since prints the first --limit after #N, and says when there are more; without it, the\n" +
    "last. The app keeps the last 1000; the numbers start again from 1 when it restarts, and a\n" +
    "--since past the latest reads from the start. When the wait runs out, nexus exits with 124.",
  flags: {
    since: { type: "number", value: "N", description: "Only the changes after #N" },
    cursors: {
      type: "string",
      value: "JSON",
      description: "Resume each device at its own cursor with --device all",
    },
    wait: {
      type: "string",
      value: "DURATION",
      description: "With none yet, wait up to DURATION (at most 30m) for the next one",
    },
    limit: {
      type: "number",
      value: "N",
      description: `At most N: the first after --since, else the last (default ${DEFAULT_LIMIT})`,
    },
    workspace: {
      type: "string",
      value: "WORKSPACE",
      description: "Only this workspace's sessions (id, id prefix or name)",
    },
    device: {
      ...DEVICE_FLAG,
      description: "A computer (id, prefix or name), or all computers with separate cursors",
    },
  },
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
    const since = flags.since as number | undefined;
    if (since !== undefined && (!Number.isInteger(since) || since < 0)) {
      throw new CliUsageError("--since takes the # of a change");
    }
    const limit = (flags.limit as number | undefined) ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new CliUsageError("--limit takes a positive whole number");
    }
    const waitMs = flags.wait === undefined ? 0 : parseDuration(flags.wait as string, "wait");
    if (waitMs > MAX_WAIT_MS) throw new CliUsageError("--wait is at most 30m");
    if (flags.device === "all") {
      return allDeviceEvents(ctx, flags, limit, waitMs);
    }
    if (flags.cursors !== undefined) throw new CliUsageError("--cursors goes with --device all");
    const device = await resolveDevice(ctx, deviceFlag(flags));
    let workspaceId: string | undefined;
    let names: Map<string, string>;
    if (device) {
      const { workspaces } = await peerSessions(ctx, device);
      names = new Map(workspaces.map((w) => [w.id, w.name]));
      workspaceId =
        flags.workspace === undefined
          ? undefined
          : pickPeerWorkspace(device, workspaces, flags.workspace as string).id;
    } else {
      names = new Map(ctx.services.listWorkspaces().map((w) => [w.id, w.name]));
      workspaceId =
        flags.workspace === undefined
          ? undefined
          : resolveWorkspace(ctx, flags.workspace as string).id;
    }
    let after = since;
    const readNext = () =>
      device
        ? readPeerEvents(ctx, device, after, limit, workspaceId)
        : readEvents(ctx, since, limit, workspaceId);

    const { clock } = ctx.services;
    const startedAt = clock.now();
    let read = await readNext();
    while (read.events.length === 0 && clock.now() - startedAt < waitMs) {
      if (ctx.signal?.aborted) break;
      if (device && workspaceId !== undefined && !read.more) after = read.cursor;
      await clock.sleep(
        Math.min(device ? PEER_POLL_MS : WAIT_POLL_MS, waitMs - (clock.now() - startedAt)),
      );
      read = await readNext();
    }
    const timedOut = waitMs > 0 && read.events.length === 0;

    const rows = read.events.map((event) => [
      `#${event.seq}`,
      clockTime(event.at),
      shortId(event.tabId),
      names.get(event.workspaceId) ?? shortId(event.workspaceId),
      oneLine(event.title, 30),
      agentOf(event),
      `${changeText(event)}${!device && event.tabId === ctx.caller.tabId ? " (you)" : ""}`,
      event.message ? oneLine(event.message, 200) : "",
    ]);
    const none = since === undefined ? "No changes yet." : `No changes after #${since}.`;
    const lastSeq = read.events.at(-1)?.seq;
    const on = device ? ` --device ${shortId(device.id)}` : "";
    const more =
      read.more && lastSeq !== undefined
        ? `\nMore after #${lastSeq}: nexus events --since ${lastSeq}${on}${workspaceId ? ` --workspace ${workspaceId}` : ""}`
        : "";
    const text =
      rows.length === 0
        ? `${none} The latest is #${read.cursor}.`
        : table(["SEQ", "TIME", "TAB", "WORKSPACE", "TITLE", "AGENT", "CHANGE", "MESSAGE"], rows) +
          more;
    const json = read.events.map((event) => ({
      ...event,
      workspace: names.get(event.workspaceId),
      ...(device ? { device: deviceRef(device) } : {}),
      ...(!device && event.tabId === ctx.caller.tabId ? { current: true } : {}),
    }));
    return output(
      text,
      { events: json, cursor: read.cursor, ...(read.more ? { more: true } : {}) },
      {
        records: json,
        ...(timedOut ? { exitCode: 124 } : {}),
      },
    );
  },
};

export const eventCommands: CliCommand[] = [events];
