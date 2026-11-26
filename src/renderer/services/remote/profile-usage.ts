import type { RpcResult } from "../../../../packages/remote-protocol/src/rpc";
import { ipcCallResult } from "../../ipc/client";
import { POLL_MS } from "../chat/plan-usage";

export type PeerProfileUsage = RpcResult<"profiles.usage">["profiles"][number];

export function watchPeerProfileUsage(
  deviceId: string,
  onResult: (profiles: PeerProfileUsage[] | null, refresh: boolean) => void,
  onRefresh: (refreshing: boolean) => void,
) {
  let stopped = false;
  let refreshing = false;
  let request: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function load(refresh: boolean) {
    if (stopped || refreshing) return;
    clearTimeout(timer);
    request?.abort();
    const controller = new AbortController();
    request = controller;
    if (refresh) {
      refreshing = true;
      onRefresh(true);
    }
    const result = await ipcCallResult(
      "remote",
      "peerProfilesUsage",
      { deviceId, ...(refresh ? { refresh: true } : {}) },
      { signal: controller.signal },
    ).catch(() => null);
    if (controller.signal.aborted) return;
    request = undefined;
    onResult(result?.ok ? result.value.profiles : null, refresh);
    if (refresh) {
      refreshing = false;
      onRefresh(false);
    }
    if (!stopped) timer = setTimeout(() => void load(false), POLL_MS);
  }

  void load(false);
  return {
    refresh: () => load(true),
    stop() {
      stopped = true;
      clearTimeout(timer);
      request?.abort();
    },
  };
}
