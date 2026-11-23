import {
  MAX_WAIT_MS,
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
} from "../../../../packages/remote-protocol/src";
import type { CliServices } from "../cli/context";
import { DEFAULT_QUIET_MS, WAIT_POLL_MS, type WaitTarget, waitOnTerminal } from "../cli/wait";
import { RpcFailure } from "./room";
import { fitsAsResult, unavailable, workspaceOf } from "./serving/common";

export const SEND_GRACE_MS = 10_000;

function fitting(message: string, rest: Record<string, unknown>): string {
  let text = message;
  while (text !== "" && !fitsAsResult({ ...rest, message: text })) {
    text = text.slice(0, Math.floor(text.length / 2));
  }
  return text;
}

async function tabsOf(services: CliServices, workspaceId: string) {
  if (!workspaceOf(services, workspaceId)) {
    throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
  }
  return (await services.ui("tabs.list", { workspaceId }).catch(unavailable)).tabs;
}

export async function waitOnChat(
  services: CliServices,
  { workspaceId, tabId, timeoutMs, after }: RpcParams<"chat.wait">,
): Promise<RpcResult<"chat.wait">> {
  const { clock } = services;
  const startedAt = clock.now();
  const limit = Math.min(timeoutMs ?? MAX_WAIT_MS, MAX_WAIT_MS);
  let first = true;
  for (;;) {
    const tab = (await tabsOf(services, workspaceId)).find((t) => t.id === tabId);
    if (!tab || (tab.type !== "claude" && tab.type !== "codex")) {
      if (first) throw new RpcFailure(RpcErrorCode.NotFound, "no such claude or codex tab");
      return { done: true, state: "closed" };
    }
    first = false;
    const info = await services
      .ui("chat.state", {
        workspaceId,
        tabId,
        peek: true,
        ...(after === undefined ? {} : { after }),
      })
      .catch(unavailable);
    const now = clock.now();
    const unseen =
      !info.trackedSubmission &&
      after !== undefined &&
      (info.since ?? 0) < after &&
      now - after < SEND_GRACE_MS;
    if (info.state !== "working" && !unseen) {
      const result = { done: true, state: info.state };
      return info.message ? { ...result, message: fitting(info.message, result) } : result;
    }
    if (now - startedAt >= limit) return { done: false, state: "working" };
    await clock.sleep(Math.min(WAIT_POLL_MS, startedAt + limit - now));
  }
}

export async function waitOnTerminalFor(
  services: CliServices,
  { workspaceId, tabId, timeoutMs, after, exit, match, quietMs }: RpcParams<"terminal.wait">,
): Promise<RpcResult<"terminal.wait">> {
  const workspace = workspaceOf(services, workspaceId);
  const tab = (await tabsOf(services, workspaceId)).find((t) => t.id === tabId);
  if (!workspace || !tab || tab.type !== "terminal") {
    throw new RpcFailure(RpcErrorCode.NotFound, "no such terminal tab");
  }
  if (exit && match !== undefined) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, "exit and match do not go together");
  }
  let target: WaitTarget = { kind: "idle" };
  if (exit) target = { kind: "exit" };
  if (match !== undefined) {
    try {
      target = { kind: "match", pattern: new RegExp(match) };
    } catch (error) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, `match: ${(error as Error).message}`);
    }
  }
  const now = services.clock.now();
  const startedAt = after !== undefined && after <= now ? after : now;
  const limit = Math.min(timeoutMs ?? MAX_WAIT_MS, MAX_WAIT_MS);
  const result = await waitOnTerminal({ services }, workspace, tab, {
    target,
    timeoutMs: now - startedAt + limit,
    quietMs: quietMs ?? DEFAULT_QUIET_MS,
    startedAt,
    afterInput: after !== undefined,
  }).catch(unavailable);
  if (!result.done) return { done: false, state: "waiting" };
  const done = { done: true, state: result.state };
  const message = result.message ?? result.text;
  return message ? { ...done, message: fitting(message, done) } : done;
}
