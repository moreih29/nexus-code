/**
 * Whether voice input can be used here: signed in to NexusCode, on a
 * server that offers it (its /info says voice). Asked again when the
 * account changes. A server that could not be asked counts as offering
 * it: starting finds out and says why.
 */

import { useEffect } from "react";
import { create } from "zustand";
import type { RemoteAccountState } from "../../../shared/remote/account";
import { ipcCallResult, ipcListen } from "../../ipc/client";
import { useLanguageStore } from "../../state/stores/language";
import { useVoiceStore } from "../../state/stores/voice";

export type VoiceAvailability = "unknown" | "signed-out" | "unavailable" | "ready";

const useAvailabilityStore = create<{ status: VoiceAvailability }>(() => ({ status: "unknown" }));

let watching = false;
let asked = 0;
let pending: Promise<void> | undefined;

async function check(account: RemoteAccountState | null): Promise<void> {
  const mine = ++asked;
  const set = (status: VoiceAvailability) => {
    if (mine === asked) useAvailabilityStore.setState({ status });
  };
  const state =
    account ??
    (await ipcCallResult("remote", "account", undefined).then(
      (r) => (r.ok ? r.value : null),
      () => null,
    ));
  if (mine !== asked) return;
  if (!state || state.status !== "signed-in") return set("signed-out");
  if (voiceAvailability() === "signed-out") set("unknown");
  const info = await ipcCallResult("remote", "serverInfo", undefined).catch(() => null);
  set(info?.ok && !info.value.voice ? "unavailable" : "ready");
}

function refresh(account: RemoteAccountState | null): void {
  const checking = check(account).finally(() => {
    if (pending === checking) pending = undefined;
  });
  pending = checking;
}

function watch(): void {
  if (watching) return;
  watching = true;
  ipcListen("remote", "accountChanged", refresh);
  refresh(null);
}

/** The last availability reported to the renderer. */
export function voiceAvailability(): VoiceAvailability {
  return useAvailabilityStore.getState().status;
}

/** Whether voice input can be used here, asked now. */
export async function voiceAvailabilityNow(): Promise<VoiceAvailability> {
  watch();
  if (!pending) refresh(null);
  while (pending) await pending;
  return voiceAvailability();
}

export function useVoiceAvailability(): VoiceAvailability {
  useEffect(watch, []);
  return useAvailabilityStore((s) => s.status);
}

/** The language to listen for: the app's, unless the user chose "multi". */
export function voiceLanguage(): string {
  if (useVoiceStore.getState().language === "multi") return "multi";
  return useLanguageStore.getState().preference;
}
