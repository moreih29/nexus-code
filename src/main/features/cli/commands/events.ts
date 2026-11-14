/**
 * nexus events: the agent sessions' state changes across the app, as the
 * agent view sees them, for an agent that follows several sessions at once.
 * The renderer logs them (services/agent-sessions/session-events.ts); this reads
 * the log, and waits on it for the next change when asked to.
 */
import type { CliSessionEvent } from "../../../../shared/cli/ui";
import { CliUsageError, exactArgs, parseDuration } from "../args";
import { type CliContext, type CliDevice, resolveWorkspace, shortId } from "../context";
import { oneLine, table } from "../format";
import { type CliCommand, output } from "../registry";
import {
  askDevice,
  DEVICE_FLAG,
  deviceFlag,
  deviceRef,
  peerSessions,
  pickPeerWorkspace,
  resolveDevice,
} from "../remote";
import { MAX_WAIT_MS, WAIT_POLL_MS } from "../wait";

const DEFAULT_LIMIT = 100;

/** The session as session list names its agent: a terminal's agent, or a tab's kind. */
function agentOf(event: CliSessionEvent): string {
  return event.kind === "terminal" ? (event.agent ?? "?") : `${event.kind}-tab`;
}

/** What changed: the state, the goal's status, or both. */
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

/** The time of day a change came, as hh:mm:ss. */
function clockTime(at: number): string {
  return new Date(at).toTimeString().slice(0, 8);
}

/**
 * The changes after `since`, the first `limit` of them (`more` when some
 * were left out), of one workspace when given; with no `since`, the last
 * `limit`. And the latest seq.
 */
async function readEvents(
  ctx: CliContext,
  since: number | undefined,
  limit: number,
  workspaceId: string | undefined,
): Promise<{ events: CliSessionEvent[]; cursor: number; more: boolean }> {
  // The log is filtered here, so the renderer is asked for all it keeps.
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

/** How often events --wait asks another computer for its changes. */
const PEER_POLL_MS = 5_000;
/** Most changes one events.read gives. */
const MAX_PEER_EVENTS = 500;

/**
 * Another computer's changes, as readEvents reads this one's: its events.read,
 * filtered to one of its workspaces when given. Its own numbers.
 */
async function readPeerEvents(
  ctx: CliContext,
  device: CliDevice,
  since: number | undefined,
  limit: number,
  workspaceId: string | undefined,
): Promise<{ events: CliSessionEvent[]; cursor: number; more: boolean }> {
  const read = await askDevice(ctx, device, "events.read", {
    ...(since !== undefined ? { since } : {}),
    limit: workspaceId === undefined ? Math.min(limit, MAX_PEER_EVENTS) : MAX_PEER_EVENTS,
  });
  // Told as this computer's are: its phase is where it came to.
  const told = read.events.map((event): CliSessionEvent => ({ ...event, phase: event.to }));
  if (workspaceId === undefined) return { ...read, events: told };
  const ours = told.filter((event) => event.workspaceId === workspaceId);
  return since === undefined
    ? { events: ours.slice(-limit), cursor: read.cursor, more: false }
    : { events: ours.slice(0, limit), cursor: read.cursor, more: read.more || ours.length > limit };
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
      description: "Another computer's changes (id, id prefix or name); --since is its #",
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
      throw new CliUsageError("--device takes one computer: each counts its changes on its own");
    }
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
    const readNext = () =>
      device
        ? readPeerEvents(ctx, device, since, limit, workspaceId)
        : readEvents(ctx, since, limit, workspaceId);

    const { clock } = ctx.services;
    const startedAt = clock.now();
    let read = await readNext();
    while (read.events.length === 0 && clock.now() - startedAt < waitMs) {
      if (ctx.signal?.aborted) break;
      // Another computer is asked through the relay: less often.
      await clock.sleep(device ? PEER_POLL_MS : WAIT_POLL_MS);
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
        ? `\nMore after #${lastSeq}: nexus events --since ${lastSeq}${on}`
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
