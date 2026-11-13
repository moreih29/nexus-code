/**
 * nexus device list: the user's computers in their account's remote room,
 * which --device names; and the sessions of the others, for session list.
 */
import type { RemoteSession, RemoteWorkspace } from "../../../../../packages/remote-protocol/src";
import { exactArgs } from "../args";
import { type CliContext, type CliDevice, shortId } from "../context";
import { ago, oneLine, table } from "../format";
import { type CliCommand, output } from "../registry";
import { deviceRef, listDevices, offline, peerSessions } from "../remote";

/** How long session list waits on the other computers for its closing hint. */
const HINT_MS = 3_000;

const deviceList: CliCommand = {
  path: ["device", "list"],
  summary: "List your computers in the remote room, as --device names them",
  details:
    "The computers signed in to your NexusCode account (Settings › Remote). A command takes\n" +
    "--device with another's id, id prefix or name to read or drive its sessions as it does\n" +
    "this computer's: session list, chat read/send/wait/new/answer/interrupt/set, tab close,\n" +
    "terminal read/send/key/wait/new, and events. Reading is always allowed; what an agent\n" +
    "changes there that computer's user allows, asks about or turns down (AGENTS yes: it takes\n" +
    "requests from agents; -: it does not, or it is offline).",
  async run(ctx, { positionals }) {
    exactArgs(positionals);
    const devices = await listDevices(ctx);
    const now = ctx.services.clock.now();
    const state = (d: CliDevice) =>
      d.self
        ? "this computer"
        : d.online
          ? "online"
          : d.lastSeen !== undefined
            ? `offline · ${ago(d.lastSeen, now)}`
            : "offline";
    const rows = devices.map((d) => [
      shortId(d.id),
      oneLine(d.name, 30),
      d.platform,
      state(d),
      !d.self && d.online && d.serves.includes("agents") ? "yes" : "-",
    ]);
    return output(
      table(["ID", "NAME", "PLATFORM", "STATE", "AGENTS"], rows) || "No computers.",
      devices.map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        self: d.self,
        online: d.online,
        ...(d.lastSeen !== undefined ? { lastSeen: d.lastSeen } : {}),
        serves: d.serves,
      })),
    );
  },
};

export const deviceCommands: CliCommand[] = [deviceList];

/** Whether a session of another device is an agent's, as session list lists them here. */
function isAgentRow(session: RemoteSession): boolean {
  return session.kind !== "terminal" || session.state !== "idle" || session.last !== undefined;
}

/** A row of session list for a session of another device, and its JSON. */
export interface PeerSessionRow {
  readonly cells: string[];
  readonly json: object;
}

function peerRow(
  device: CliDevice,
  workspaces: readonly RemoteWorkspace[],
  session: RemoteSession,
  now: number,
): PeerSessionRow {
  const workspace = workspaces.find((w) => w.id === session.workspaceId);
  const agent =
    session.kind === "terminal"
      ? "terminal"
      : `${session.kind}-tab${session.profile ? ` (${oneLine(session.profile, 20)})` : ""}`;
  return {
    cells: [
      shortId(session.tabId),
      oneLine(device.name, 20),
      workspace?.name ?? shortId(session.workspaceId),
      oneLine(session.title, 30),
      agent,
      session.state,
      session.since !== undefined ? ago(session.since, now) : "",
      oneLine(session.waiting?.text ?? session.last ?? "", 60),
    ],
    json: {
      id: session.tabId,
      device: deviceRef(device),
      workspaceId: session.workspaceId,
      workspace: workspace?.name ?? null,
      title: session.title,
      tab: session.kind === "terminal" ? "terminal" : session.kind,
      state: session.state,
      ...(session.since !== undefined ? { since: session.since } : {}),
      ...(session.last ? { message: session.last } : {}),
      ...(session.profile ? { profile: session.profile } : {}),
      ...(session.waiting ? { waiting: session.waiting } : {}),
    },
  };
}

/**
 * The agent sessions of `devices` for session list, a row each; an offline
 * device, or one that does not answer, is a line saying so instead of
 * failing the list.
 */
export async function peerSessionRows(
  ctx: CliContext,
  devices: readonly CliDevice[],
): Promise<{ rows: PeerSessionRow[]; notes: string[] }> {
  const now = ctx.services.clock.now();
  const listed = await Promise.all(
    devices.map(async (device) => {
      if (!device.online) return { device, error: offline(device, now).message };
      try {
        return { device, ...(await peerSessions(ctx, device)) };
      } catch (error) {
        return { device, error: (error as Error).message };
      }
    }),
  );
  const rows: PeerSessionRow[] = [];
  const notes: string[] = [];
  for (const entry of listed) {
    if ("error" in entry) {
      notes.push(entry.error as string);
      continue;
    }
    for (const session of entry.sessions.filter(isAgentRow)) {
      rows.push(peerRow(entry.device, entry.workspaces, session, now));
    }
  }
  return { rows, notes };
}

/**
 * The hint session list ends with when the other computers have agent
 * sessions: "+ 5 sessions on 1 other computer: ...". Empty when this
 * computer is not in the room or they have none; they get a moment to say.
 */
export async function otherSessionsHint(ctx: CliContext): Promise<string> {
  if (!ctx.services.remote.inRoom()) return "";
  const counted = (async () => {
    const devices = (await ctx.services.remote.devices()).filter((d) => !d.self && d.online);
    const counts = await Promise.all(
      devices.map((device) =>
        peerSessions(ctx, device)
          .then((listed) => listed.sessions.filter(isAgentRow).length)
          .catch(() => 0),
      ),
    );
    return counts.filter((n) => n > 0);
  })().catch(() => [] as number[]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<number[]>((resolve) => {
    timer = setTimeout(() => resolve([]), HINT_MS);
  });
  const counts = await Promise.race([counted, timeout]).finally(() => clearTimeout(timer));
  if (counts.length === 0) return "";
  const total = counts.reduce((a, b) => a + b, 0);
  const sessions = `${total} session${total === 1 ? "" : "s"}`;
  const computers = `${counts.length} other computer${counts.length === 1 ? "" : "s"}`;
  return `+ ${sessions} on ${computers}: nexus session list --device all`;
}
