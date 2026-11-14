/**
 * The nexus command on another computer of the user's (--device): which
 * device a flag names, asking it through the remote's room, and its
 * failures as the command tells them, with their exit codes.
 */
import {
  AGENT_CONSENT_MS,
  type AgentSender,
  MAX_WAIT_MS,
  type RemoteSession,
  type RemoteWorkspace,
  RpcErrorCode,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
} from "../../../../packages/remote-protocol/src";
import { type CliContext, type CliDevice, CliError, pick } from "./context";
import { ago } from "./format";
import { refuseLoop } from "./hops";
import { senderOf } from "./sender";

export const DEVICE_FLAG = {
  type: "string",
  value: "DEVICE",
  description:
    "Another computer of yours (id, id prefix or name), through the remote; this one by default",
} as const;

export const NOT_IN_ROOM = "this computer is not in the remote room (Settings › Remote)";

/** How long a request an agent sends waits: the user there may be asked first. */
const AGENT_REQUEST_MS = AGENT_CONSENT_MS + 10_000;
/** How long a wait's request waits: its own time and the way there and back. */
const WAIT_REQUEST_MS = MAX_WAIT_MS + 5_000;

/** A device as JSON names it beside what came from it. */
export function deviceRef(device: CliDevice): { id: string; name: string } {
  return { id: device.id, name: device.name };
}

function notInRoom(): CliError {
  return new CliError(NOT_IN_ROOM, 3, { error: "not-in-room" });
}

/** "Mac mini" is offline (last seen 12m ago), exit 3. */
export function offline(device: CliDevice, now: number): CliError {
  const seen = device.lastSeen !== undefined ? ` (last seen ${ago(device.lastSeen, now)})` : "";
  return new CliError(`"${device.name}" is offline${seen}`, 3, {
    error: "offline",
    device: deviceRef(device),
    ...(device.lastSeen !== undefined ? { lastSeen: device.lastSeen } : {}),
  });
}

/** The account's devices; a CliError when this computer is not in its room. */
export async function listDevices(ctx: CliContext): Promise<CliDevice[]> {
  if (!ctx.services.remote.inRoom()) throw notInRoom();
  return ctx.services.remote.devices();
}

/**
 * The other computer a --device flag names, by id, id prefix or name; null
 * when the flag is left out (this computer). Naming this computer is an
 * error: the command is to be run without the flag.
 */
export async function resolveDevice(
  ctx: CliContext,
  selector: string | undefined,
): Promise<CliDevice | null> {
  if (selector === undefined) return null;
  const device = pick(
    await listDevices(ctx),
    selector,
    (d) => d.id,
    (d) => d.name,
    "device",
  );
  if (device.self) {
    throw new CliError(`"${device.name}" is this computer: leave --device out`, 2);
  }
  return device;
}

/** The --device flag as a command reads it. */
export function deviceFlag(flags: Record<string, unknown>): string | undefined {
  return typeof flags.device === "string" ? flags.device : undefined;
}

/**
 * Who runs the command, as the other computer is told it: what it does
 * there is an agent's, gated by that computer's setting for agents. So is
 * what the user runs at a shell of theirs: the command is what agents run,
 * and one in a terminal that is no Claude Code or Codex is not told from
 * the user, so it goes as an agent in that terminal.
 */
export async function agentSenderOf(ctx: CliContext): Promise<AgentSender> {
  const sender = await senderOf(ctx);
  if (!sender) {
    const { workspaceId, tabId } = ctx.caller;
    return { kind: "terminal", workspaceId, tabId, hops: 1 };
  }
  refuseLoop(sender);
  return {
    kind: sender.kind,
    ...(sender.agent ? { agent: sender.agent } : {}),
    workspaceId: sender.workspaceId ?? ctx.caller.workspaceId,
    tabId: sender.tabId ?? ctx.caller.tabId,
    ...(sender.name ? { name: sender.name } : {}),
    hops: sender.hops ?? 1,
  };
}

/** An error of the protocol's, as the room rejects a request with. */
function rpcCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

/** A failure of a request to `device`, as the command tells it. */
function failureOf(device: CliDevice, method: RpcMethod, error: unknown, now: number): Error {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const ref = deviceRef(device);
  switch (rpcCode(error)) {
    case RpcErrorCode.MethodNotFound:
      return new CliError(`"${device.name}" runs an older NexusCode (no ${method})`, 3, {
        error: "older",
        device: ref,
        method,
      });
    case RpcErrorCode.Forbidden:
      return new CliError(`"${device.name}" refused: ${message}`, 1, {
        error: "refused",
        device: ref,
        message,
      });
    case RpcErrorCode.Unavailable:
      // This computer left its room, or the other one did.
      if (message === "not in the room" || message === "left the room") return notInRoom();
      if (message.includes("device is not in the room")) return offline(device, now);
      if (/no answer in time/.test(message)) {
        return new CliError(`"${device.name}" did not answer in time (${method})`, 3, {
          error: "timeout",
          device: ref,
          method,
        });
      }
      return new CliError(`on "${device.name}": ${message}`, 1, {
        error: "unavailable",
        device: ref,
        message,
      });
    case RpcErrorCode.NotFound:
      return new CliError(`on "${device.name}": ${message}`, 1, {
        error: "not-found",
        device: ref,
        message,
      });
    default:
      return new CliError(`on "${device.name}": ${message}`, 1, {
        error: "failed",
        device: ref,
        message,
      });
  }
}

/**
 * Asks `device` for `method`: a request with `from` waits on its user's
 * consent, a wait on its own time. Offline, older and refusing devices
 * are CliErrors as the command tells them.
 */
export async function askDevice<M extends RpcMethod>(
  ctx: CliContext,
  device: CliDevice,
  method: M,
  params: RpcParams<M>,
): Promise<RpcResult<M>> {
  const now = ctx.services.clock.now();
  if (!device.online) throw offline(device, now);
  const from = (params as { from?: AgentSender }).from;
  if (from && !device.serves.includes("agents")) {
    throw device.schema === undefined
      ? new CliError(`"${device.name}" runs an older NexusCode (no requests from agents)`, 3, {
          error: "older",
          device: deviceRef(device),
          method,
        })
      : new CliError(`"${device.name}" does not take requests from agents (Settings › Remote)`, 1, {
          error: "refused",
          device: deviceRef(device),
          message: "does not take requests from agents",
        });
  }
  const timeoutMs =
    method === "chat.wait" || method === "terminal.wait"
      ? WAIT_REQUEST_MS
      : from
        ? AGENT_REQUEST_MS
        : undefined;
  try {
    return await ctx.services.remote.request(device.id, method, params, timeoutMs);
  } catch (error) {
    throw failureOf(device, method, error, ctx.services.clock.now());
  }
}

/** A device's workspaces and sessions, as its sessions.list tells them. */
export async function peerSessions(
  ctx: CliContext,
  device: CliDevice,
): Promise<{ workspaces: RemoteWorkspace[]; sessions: RemoteSession[] }> {
  return askDevice(ctx, device, "sessions.list", {});
}

/** The workspace a --workspace flag names on `device`; "." is no workspace there. */
export function pickPeerWorkspace(
  device: CliDevice,
  workspaces: readonly RemoteWorkspace[],
  selector: string | undefined,
): RemoteWorkspace {
  if (selector === undefined || selector === ".") {
    throw new CliError(`give --workspace: which of "${device.name}"'s workspaces`, 2);
  }
  return pick(
    workspaces,
    selector,
    (w) => w.id,
    (w) => w.name,
    `workspace on "${device.name}"`,
  );
}

/** A session of another device, found as `<tab> --workspace <ws> --device <d>` names it. */
export interface PeerTab {
  readonly device: CliDevice;
  readonly workspace: RemoteWorkspace;
  readonly session: RemoteSession;
}

/**
 * The session a tab selector names on `device`: in the workspace
 * --workspace names, or among all of its sessions when that is left out.
 * `kinds` narrows it to chats or terminals.
 */
export async function resolvePeerTab(
  ctx: CliContext,
  device: CliDevice,
  workspaceSelector: string | undefined,
  tabSelector: string,
  kinds: readonly RemoteSession["kind"][] = ["claude", "codex", "terminal"],
): Promise<PeerTab> {
  if (tabSelector === ".")
    throw new CliError(`"." is a tab of this computer's, not "${device.name}"'s`, 2);
  const { workspaces, sessions } = await peerSessions(ctx, device);
  const workspace =
    workspaceSelector === undefined
      ? undefined
      : pickPeerWorkspace(device, workspaces, workspaceSelector);
  const what = kinds.every((k) => k === "terminal")
    ? "terminal"
    : kinds.includes("terminal")
      ? "tab"
      : "Claude or Codex tab";
  const session = pick(
    sessions.filter(
      (s) => kinds.includes(s.kind) && (!workspace || s.workspaceId === workspace.id),
    ),
    tabSelector,
    (s) => s.tabId,
    (s) => s.title,
    `${what} on "${device.name}"`,
  );
  const found = workspace ?? workspaces.find((w) => w.id === session.workspaceId);
  if (!found) throw new CliError(`on "${device.name}": no workspace of tab ${tabSelector}`);
  return { device, workspace: found, session };
}
