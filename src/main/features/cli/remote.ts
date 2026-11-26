import {
  AGENT_CONSENT_MS,
  type AgentSender,
  type Capability,
  MAX_FILE_WRITE_BYTES,
  MAX_WAIT_MS,
  type RemoteSession,
  type RemoteWorkspace,
  RpcErrorCode,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  UNTIMED_CONSENT_SCHEMA,
} from "../../../../packages/remote-protocol/src";
import { PEER_USAGE_REFRESH_TIMEOUT_MS } from "../../../shared/cli/ui";
import { speaks } from "../../../shared/remote/room";
import { fileVerifyTimeoutMs, isFileTransferMethod, needsFileConsent } from "../remote/file-io";
import { type CliContext, type CliDevice, CliError, pick } from "./context";
import { ago } from "./format";
import { senderOf } from "./sender";

export const DEVICE_FLAG = {
  type: "string",
  value: "DEVICE",
  description:
    "Another computer of yours (id, id prefix or name), through the remote; this one by default",
} as const;

export const NOT_IN_ROOM = "this computer is not in the remote room (Settings › Remote)";

const AGENT_REQUEST_MS = AGENT_CONSENT_MS + 10_000;
const PEER_APPLY_MS = AGENT_CONSENT_MS + 70_000;
const WAIT_REQUEST_MS = MAX_WAIT_MS + 5_000;
const FILE_WRITE_END_REQUEST_MS = fileVerifyTimeoutMs(MAX_FILE_WRITE_BYTES) + 35_000;

export function deviceRef(device: CliDevice): { id: string; name: string } {
  return { id: device.id, name: device.name };
}

function notInRoom(): CliError {
  return new CliError(NOT_IN_ROOM, 3, { error: "not-in-room" });
}

export function offline(device: CliDevice, now: number): CliError {
  const seen = device.lastSeen !== undefined ? ` (last seen ${ago(device.lastSeen, now)})` : "";
  return new CliError(`"${device.name}" is offline${seen}`, 3, {
    error: "offline",
    device: deviceRef(device),
    ...(device.lastSeen !== undefined ? { lastSeen: device.lastSeen } : {}),
  });
}

export async function listDevices(ctx: CliContext): Promise<CliDevice[]> {
  const devices = await ctx.services.remote.devices(ctx.signal);
  if (!devices) throw notInRoom();
  return devices;
}

export async function resolveDevice(
  ctx: CliContext,
  selector: string | undefined,
): Promise<CliDevice | null> {
  if (selector === undefined) return null;
  const device = pickDevice(await listDevices(ctx), selector);
  if (device.self) {
    throw new CliError(`"${device.name}" is this computer: leave --device out`, 2);
  }
  return device;
}

export function pickDevice(devices: readonly CliDevice[], selector: string): CliDevice {
  try {
    return pick(
      devices,
      selector,
      (d) => d.id,
      (d) => d.name,
      "device",
    );
  } catch (error) {
    const lower = selector.toLowerCase();
    const byHost = devices.filter((d) => d.hostName?.toLowerCase() === lower);
    if (byHost.length === 1) return byHost[0] as CliDevice;
    throw error;
  }
}

export function deviceFlag(flags: Record<string, unknown>): string | undefined {
  return typeof flags.device === "string" ? flags.device : undefined;
}

export async function agentSenderOf(ctx: CliContext): Promise<AgentSender> {
  const sender = await senderOf(ctx);
  if (!sender || sender.kind === "app" || sender.device) {
    const { workspaceId, tabId } = ctx.caller;
    return { kind: "terminal", workspaceId, tabId };
  }
  return {
    kind: sender.kind,
    ...(sender.agent ? { agent: sender.agent } : {}),
    workspaceId: sender.workspaceId ?? ctx.caller.workspaceId,
    tabId: sender.tabId ?? ctx.caller.tabId,
    ...(sender.name ? { name: sender.name } : {}),
  };
}

function rpcCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

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
      if (message === "not in the room" || message === "left the room") return notInRoom();
      if (message.includes("device is not in the room")) return offline(device, now);
      if (/(?:no answer|did not answer) in time/.test(message)) {
        const outcome = (error as { data?: { outcome?: "unknown" | "rejected" } }).data?.outcome;
        const uncertainty = outcome === "unknown" ? "; the change may have been applied" : "";
        return new CliError(
          `"${device.name}" did not answer in time (${method})${uncertainty}`,
          3,
          {
            error: "timeout",
            device: ref,
            method,
            ...(outcome ? { outcome } : {}),
          },
        );
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

const AGENT_READS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  "sessions.list",
  "chat.read",
  "chat.wait",
  "terminal.read",
  "terminal.wait",
  "events.read",
  "chat.commands",
  "chat.panel",
  "chat.tool",
  "chat.fileSuggestions",
  "chat.instructions",
  "settings.instructions",
  "chat.entryItem",
  "chat.rewindPreview",
  "chat.image",
  "history.list",
  "profiles.list",
  "profiles.usage",
  "terminal.shells",
  "notes.list",
  "notes.read",
  "notes.transcript",
  "notes.voiceNames.list",
  "notes.voiceSuggestions.list",
  "layout.get",
  "agentView.get",
  "browser.permissions",
]);

export async function askDevice<M extends RpcMethod>(
  ctx: CliContext,
  device: CliDevice,
  method: M,
  given: RpcParams<M>,
  signal?: AbortSignal,
): Promise<RpcResult<M>> {
  signal?.throwIfAborted();
  if (method === "consent.answer") {
    throw new CliError("consent prompts are answered by the user in the app", 1, {
      error: "refused",
      device: deviceRef(device),
      message: "consent prompts are answered by the user in the app",
    });
  }
  const now = ctx.services.clock.now();
  if (!device.online) throw offline(device, now);
  const reads = AGENT_READS.has(method);
  const params =
    reads && (given as { from?: AgentSender }).from === undefined
      ? ({ ...given, from: await agentSenderOf(ctx) } as RpcParams<M>)
      : given;
  const from = (params as { from?: AgentSender }).from;
  if (from && !device.serves.includes("agents")) {
    throw new CliError(
      `"${device.name}" does not take requests from agents (Settings › Remote)`,
      1,
      {
        error: "refused",
        device: deviceRef(device),
        message: "does not take requests from agents",
      },
    );
  }
  if (
    from &&
    (method === "chat.new" || method === "chat.configure") &&
    (params as { permissionMode?: string }).permissionMode !== undefined
  )
    requirePeerCli(ctx, device);
  const slow = [
    "worktree.new",
    "worktree.remove",
    "notes.speakers",
    "notes.voiceSuggestions.list",
    "notes.voiceSuggestions.change",
  ].includes(method);
  const applies =
    from !== undefined &&
    [
      "chat.rewind",
      "chat.command",
      "chat.remoteControl",
      "chat.send",
      "chat.configure",
      "chat.new",
      "chat.profile",
      "settings.instructions.set",
      "notes.voiceNames.delete",
    ].includes(method);
  const asksUser =
    applies ||
    (from !== undefined &&
      !reads &&
      (!isFileTransferMethod(method) || needsFileConsent(method, params as { anywhere?: true })));
  let timeoutMs =
    method === "chat.wait" || method === "terminal.wait"
      ? WAIT_REQUEST_MS
      : method === "files.write.end"
        ? FILE_WRITE_END_REQUEST_MS
        : slow
          ? AGENT_REQUEST_MS + 5 * 60_000
          : applies
            ? PEER_APPLY_MS
            : asksUser
              ? AGENT_REQUEST_MS
              : undefined;
  if (method === "profiles.usage" && (params as RpcParams<"profiles.usage">).refresh) {
    timeoutMs = PEER_USAGE_REFRESH_TIMEOUT_MS;
  }
  if (asksUser && method !== "files.write.end" && speaks(device.schema, UNTIMED_CONSENT_SCHEMA)) {
    timeoutMs = Number.POSITIVE_INFINITY;
  }
  try {
    return await ctx.services.remote.request(
      device.id,
      method,
      params,
      timeoutMs,
      signal ?? ctx.signal,
    );
  } catch (error) {
    signal?.throwIfAborted();
    const failure = failureOf(device, method, error, ctx.services.clock.now());
    if (failure !== error) failure.cause = error;
    throw failure;
  }
}

export function requirePeerCli(
  ctx: CliContext,
  device: CliDevice,
  capability: Capability = "agents.cli",
): void {
  if (!device.online) throw offline(device, ctx.services.clock.now());
  if (!device.serves.includes(capability)) {
    throw new CliError(`Update NexusCode on "${device.name}" to use this command there`, 3, {
      error: "older",
      device: deviceRef(device),
    });
  }
}

export function askPeerCli<M extends RpcMethod>(
  ctx: CliContext,
  device: CliDevice,
  method: M,
  params: RpcParams<M>,
): Promise<RpcResult<M>> {
  requirePeerCli(ctx, device);
  return askDevice(ctx, device, method, params, ctx.signal);
}

type WithoutSender<T> = T extends unknown ? Omit<T, "from"> : never;

export async function changePeerCli<M extends RpcMethod>(
  ctx: CliContext,
  device: CliDevice,
  method: M,
  params: WithoutSender<RpcParams<M>>,
): Promise<RpcResult<M>> {
  requirePeerCli(ctx, device);
  return askDevice(
    ctx,
    device,
    method,
    { ...params, from: await agentSenderOf(ctx) } as RpcParams<M>,
    ctx.signal,
  );
}

export async function peerSessions(
  ctx: CliContext,
  device: CliDevice,
  signal?: AbortSignal,
): Promise<{ workspaces: RemoteWorkspace[]; sessions: RemoteSession[] }> {
  return askDevice(ctx, device, "sessions.list", {}, signal);
}

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

export async function peerWorkspace(ctx: CliContext, device: CliDevice, selector: unknown) {
  const { workspaces } = await peerSessions(ctx, device, ctx.signal);
  return pickPeerWorkspace(device, workspaces, typeof selector === "string" ? selector : undefined);
}

export interface PeerTab {
  readonly device: CliDevice;
  readonly workspace: RemoteWorkspace;
  readonly session: RemoteSession;
}

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
