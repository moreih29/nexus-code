/**
 * How far down a chain of messages between agents a message is: one an
 * agent sends in a turn the user started counts 1; in a turn another
 * agent's message started, one more than that message. One past
 * MAX_AGENT_HOPS is not sent, here or from another computer, so agents
 * cannot keep each other going without end.
 *
 * A chat keeps who sent each message, hops and all (relayed). A terminal
 * keeps nothing of what was typed into it, so the agents' input is told
 * here as it is typed.
 */
import { MAX_AGENT_HOPS } from "../../../../packages/remote-protocol/src";
import type { RelaySender } from "../../../shared/chat/relay";
import { CliError } from "./context";

/** After an agent's input, how long the turn it starts may take to begin. */
const TURN_START_MS = 30_000;
/** For a terminal agent whose turns are not told, how long its input counts. */
const UNTOLD_TURN_MS = 10 * 60_000;

export class AgentInputs {
  /** The last agent's input into each terminal ("workspace|tab"): its hops, when. */
  private readonly last = new Map<string, { hops: number; at: number }>();

  record(workspaceId: string, tabId: string, hops: number, at: number): void {
    this.last.set(`${workspaceId}|${tabId}`, { hops, at });
  }

  /**
   * The hops of the agent's input that started the terminal's current turn
   * (`turnStartedAt`, when its agent tells its turns); 0 for the user's.
   */
  turnHops(
    workspaceId: string,
    tabId: string,
    turnStartedAt: number | undefined,
    now: number,
  ): number {
    const input = this.last.get(`${workspaceId}|${tabId}`);
    if (!input) return 0;
    if (turnStartedAt !== undefined) {
      const after = turnStartedAt - input.at;
      return after >= -1000 && after < TURN_START_MS ? input.hops : 0;
    }
    return now - input.at < UNTOLD_TURN_MS ? input.hops : 0;
  }

  forget(workspaceId: string, tabId: string): void {
    this.last.delete(`${workspaceId}|${tabId}`);
  }
}

/** Refuses a message from an agent past the chain's length: a loop, most likely. */
export function refuseLoop(from: RelaySender | undefined): void {
  if (from?.hops !== undefined && from.hops > MAX_AGENT_HOPS) {
    throw new CliError(`the agents' chain is too long (${MAX_AGENT_HOPS} messages): a loop?`);
  }
}
