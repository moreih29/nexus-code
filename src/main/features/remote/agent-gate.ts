/**
 * Whether an agent on another computer of the user's may do what it asks
 * here (a request with `from`, from that computer's nexus command): not
 * past MAX_AGENT_HOPS messages between agents, not more than
 * MAX_AGENT_REQUESTS_PER_MINUTE from one agent nor
 * MAX_DEVICE_AGENT_REQUESTS_PER_MINUTE from all of one device's, not more
 * than MAX_PENDING_PROMPTS_PER_DEVICE prompts of one device's waiting on
 * the user at once, and as the user set it
 * (Settings › Remote): allowed, turned down, or asked about as the nexus
 * command's changes to another workspace are: for this once, or for that
 * kind of change from that computer's workspace to this one until the app
 * restarts. What is typed, sent or run is asked about each time
 * (askedEachTime).
 */
import {
  AGENT_CONSENT_MS,
  type AgentSender,
  MAX_AGENT_HOPS,
  MAX_AGENT_REQUESTS_PER_MINUTE,
  MAX_DEVICE_AGENT_REQUESTS_PER_MINUTE,
  RpcErrorCode,
  type RpcMethod,
} from "../../../../packages/remote-protocol/src";
import type { RelaySender } from "../../../shared/chat/relay";
import { askedEachTime, type CliChange } from "../../../shared/cli/ui";
import type { RemoteAgentsPolicy } from "../../../shared/types/app-state";
import type { CliServices } from "../cli/context";
import { RpcFailure } from "./room";

const MINUTE_MS = 60_000;

/**
 * Most prompts one device's agents may have waiting on the user here at
 * once: more are turned away, not stacked up behind the ones shown.
 */
export const MAX_PENDING_PROMPTS_PER_DEVICE = 3;

/** A request an agent made, as it came: from which device, for what. */
export interface AgentRequest {
  readonly device: { readonly id: string; readonly name: string };
  readonly method: RpcMethod;
  readonly params: { readonly workspaceId: string; readonly tabId?: string } & Record<
    string,
    unknown
  > & { readonly from: AgentSender };
}

export interface AgentGateDeps {
  policy(): RemoteAgentsPolicy;
  now?: () => number;
}

const forbidden = (message: string) => new RpcFailure(RpcErrorCode.Forbidden, message);

export class AgentGate {
  /**
   * When each agent ("device|workspace|tab") and each device ("device")
   * asked lately, within the last minute.
   */
  private readonly recent = new Map<string, number[]>();
  /** The prompts waiting on the user, by the device whose agent asked. */
  private readonly prompting = new Map<string, number>();
  /** "device|its workspace>this workspace>kind" the user allowed until restart. */
  private readonly allowed = new Set<string>();

  constructor(private readonly deps: AgentGateDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Resolves when the request may go ahead; a RpcFailure saying why when not. */
  async check(services: CliServices, request: AgentRequest): Promise<void> {
    const { device, params } = request;
    const { from } = params;
    if (from.hops > MAX_AGENT_HOPS) {
      throw forbidden(`the agents' chain is too long (${MAX_AGENT_HOPS} messages): a loop?`);
    }
    // The device's share first: its agents' names are its to make up.
    this.count(
      device.id,
      MAX_DEVICE_AGENT_REQUESTS_PER_MINUTE,
      "too many messages from that device",
    );
    this.count(
      `${device.id}|${from.workspaceId}|${from.tabId}`,
      MAX_AGENT_REQUESTS_PER_MINUTE,
      "too many messages from that agent",
    );
    refuseBeyondAsked(request);
    const policy = this.deps.policy();
    if (policy === "deny") throw forbidden("control by agents is off there (Settings › Remote)");
    if (policy === "allow") return;
    const change = await changeOf(services, request);
    // What it types, sends or runs, an answer, a looser mode, a profile:
    // asked about each time, never for a while.
    const eachTime = askedEachTime(change);
    const key = `${device.id}|${from.workspaceId}>${params.workspaceId}>${change.kind}`;
    if (!eachTime && this.allowed.has(key)) return;
    const waiting = this.prompting.get(device.id) ?? 0;
    if (waiting >= MAX_PENDING_PROMPTS_PER_DEVICE) {
      throw new RpcFailure(
        RpcErrorCode.Unavailable,
        "the user there has that device's agents' prompts waiting already: try again once they answer",
      );
    }
    this.prompting.set(device.id, waiting + 1);
    const { answer } = await services
      .ui(
        "consent.ask",
        {
          fromWorkspaceId: from.workspaceId,
          fromTabId: from.tabId,
          toWorkspaceId: params.workspaceId,
          change,
          timeoutMs: AGENT_CONSENT_MS,
          fromDevice: device.name,
          fromDeviceId: device.id,
          ...(from.name ? { fromName: from.name } : {}),
        },
        AGENT_CONSENT_MS + 10_000,
      )
      .catch((error: unknown) => {
        throw new RpcFailure(
          RpcErrorCode.Unavailable,
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        const left = (this.prompting.get(device.id) ?? 1) - 1;
        if (left > 0) this.prompting.set(device.id, left);
        else this.prompting.delete(device.id);
      });
    if (answer === "session" && !eachTime) this.allowed.add(key);
    if (answer === "once" || answer === "session") return;
    throw forbidden(
      answer === "timeout"
        ? "the user there did not answer in time; nothing was done"
        : "the user there did not allow it",
    );
  }

  /** Counts a request of `key`; Unavailable, saying `why`, past the minute's `max`. */
  private count(key: string, max: number, why: string): void {
    const now = this.now();
    const times = (this.recent.get(key) ?? []).filter((at) => now - at < MINUTE_MS);
    if (times.length >= max) {
      this.recent.set(key, times);
      throw new RpcFailure(RpcErrorCode.Unavailable, why);
    }
    times.push(now);
    this.recent.set(key, times);
    // Agents that stopped asking are let go of.
    for (const [k, list] of this.recent) {
      if (list.every((at) => now - at >= MINUTE_MS)) this.recent.delete(k);
    }
  }
}

/**
 * An agent answers a permission request only as it was asked, and once:
 * the consent prompt shows the request as it came, so a changed one
 * (updatedInput) would run what the user never saw, and a rule kept for
 * good (always, allowAlways) would outlast the one answer they allowed.
 */
function refuseBeyondAsked({ method, params }: AgentRequest): void {
  const changed =
    method === "chat.answer" &&
    (params.updatedInput !== undefined ||
      (Array.isArray(params.always) && params.always.length > 0));
  if (changed || (method === "terminal.answer" && params.decision === "allowAlways")) {
    throw forbidden("an agent may answer a request only as it was asked, and only once");
  }
}

/** The agent's sender as the chat it writes to keeps it: who, on which computer, how far down the chain. */
export function relaySenderOf(
  from: AgentSender,
  device: { id: string; name: string },
): RelaySender {
  return {
    kind: from.kind,
    ...(from.agent === "claude" || from.agent === "codex" ? { agent: from.agent } : {}),
    ...(from.name ? { name: from.name.slice(0, 200) } : {}),
    workspaceId: from.workspaceId,
    tabId: from.tabId,
    device: { id: device.id, name: device.name.slice(0, 200) },
    hops: from.hops,
  };
}

const AGENT_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex" };

async function tabTitle(services: CliServices, workspaceId: string, tabId: string) {
  const { tabs } = await services.ui("tabs.list", { workspaceId }).catch(() => ({ tabs: [] }));
  return tabs.find((t) => t.id === tabId)?.title ?? tabId.slice(0, 8);
}

/** What the user is asked to let the agent do, as the consent prompt says it. */
async function changeOf(
  services: CliServices,
  { method, params }: AgentRequest,
): Promise<CliChange> {
  const { workspaceId, tabId = "" } = params;
  const title = () => tabTitle(services, workspaceId, tabId);
  switch (method) {
    case "chat.send":
      return { kind: "chatInput", detail: await title(), body: String(params.text) };
    case "chat.new":
      return {
        kind: "chatNew",
        detail: AGENT_NAMES[String(params.agent)] ?? String(params.agent),
        ...(typeof params.prompt === "string" && params.prompt.trim() !== ""
          ? { body: params.prompt }
          : {}),
      };
    case "chat.interrupt":
      return { kind: "chatInterrupt", detail: await title() };
    case "chat.configure":
      return typeof params.permissionMode === "string"
        ? { kind: "chatMode", detail: `"${await title()}" (${params.permissionMode})` }
        : { kind: "chatSettings", detail: await title() };
    case "chat.close":
      return { kind: "tabClose", detail: await title() };
    case "terminal.close":
      return { kind: "tabClose", detail: await title(), terminal: true };
    case "terminal.open":
      return {
        kind: "terminalNew",
        ...(typeof params.command === "string" ? { body: params.command } : {}),
      };
    case "terminal.input": {
      const typed = [
        typeof params.text === "string" ? params.text : "",
        ...(Array.isArray(params.keys) ? params.keys.map((k) => `<${String(k)}>`) : []),
        params.enter === true ? "<enter>" : "",
      ].join("");
      return { kind: "terminalInput", detail: await title(), ...(typed ? { body: typed } : {}) };
    }
    case "chat.answer": {
      const info = await services
        .ui("chat.state", { workspaceId, tabId, peek: true })
        .catch(() => null);
      const what = info?.waiting?.text ?? info?.request?.tool ?? (await title());
      return {
        kind: params.decision === "deny" ? "permissionDeny" : "permissionAllow",
        detail: what,
      };
    }
    case "terminal.answer": {
      const ask = services.claudeAsks(workspaceId, tabId).find((a) => a.id === params.requestId);
      const what = ask ? [ask.tool, ask.target].filter(Boolean).join(" ") : await title();
      return {
        kind: String(params.decision).startsWith("deny") ? "permissionDeny" : "permissionAllow",
        detail: what,
      };
    }
    default:
      throw forbidden(`${method} is not taken from agents`);
  }
}
