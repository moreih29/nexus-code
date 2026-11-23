import i18next from "i18next";
import { create } from "zustand";
import { showConfirmDialog } from "@/components/ui/confirm-dialog";
import { dismissToast, showToast } from "@/components/ui/toast";
import { ipcCallResult, ipcListen, unwrapIpcResult } from "@/ipc/client";
import { useReleaseNotesStore } from "@/state/stores/release-notes";
import type { KeychainStatus } from "../../shared/keychain";

export const useKeychain = create<{ status: KeychainStatus | null }>(() => ({ status: null }));

function releaseNotesClosed(): Promise<void> {
  if (!useReleaseNotesStore.getState().open) return Promise.resolve();
  return new Promise((resolve) => {
    const off = useReleaseNotesStore.subscribe(({ open }) => {
      if (open) return;
      off();
      resolve();
    });
  });
}

export function keychainItemsText(status: KeychainStatus): string {
  return status.items.map((item) => i18next.t(`common:keychain.items.${item}`)).join(", ");
}

let asking: Promise<void> | undefined;
let question: AbortController | undefined;

function ask(): Promise<void> {
  asking ??= (async () => {
    await releaseNotesClosed();
    const { prompt, status } = unwrapIpcResult(
      await ipcCallResult("keychain", "claimPrompt", undefined),
    );
    apply(status);
    if (!prompt || status.state !== "ask") return;
    const asked = new AbortController();
    question = asked;
    const open = await showConfirmDialog({
      signal: asked.signal,
      title: i18next.t("common:keychain.prompt.title"),
      description: i18next.t("common:keychain.prompt.description", {
        items: keychainItemsText(status),
      }),
      hint: i18next.t("common:keychain.prompt.hint"),
      cancelLabel: i18next.t("common:keychain.prompt.later"),
      confirmLabel: i18next.t("common:keychain.prompt.continue"),
    });
    if (question === asked) question = undefined;
    if (asked.signal.aborted) return;
    apply(unwrapIpcResult(await ipcCallResult("keychain", "answer", { open })));
  })()
    .catch(() => {})
    .finally(() => {
      asking = undefined;
    });
  return asking;
}

let toast: number | undefined;

function showAsking(busy: boolean): void {
  if (busy && toast === undefined) {
    toast = showToast({
      kind: "info",
      message: i18next.t("common:keychain.asking"),
      durationMs: Number.POSITIVE_INFINITY,
    });
  } else if (!busy && toast !== undefined) {
    dismissToast(toast);
    toast = undefined;
  }
}

function apply(status: KeychainStatus): void {
  useKeychain.setState({ status });
  showAsking(status.busy);
  if (status.state === "ask") void ask();
  else question?.abort();
}

export function startKeychain(): () => void {
  let initial = true;
  const off = ipcListen("keychain", "changed", (status) => {
    initial = false;
    apply(status);
  });
  void ipcCallResult("keychain", "status", undefined)
    .then((result) => {
      if (initial && result.ok) apply(result.value);
    })
    .catch(() => {});
  return () => {
    initial = false;
    off();
  };
}

export async function openKeychain(): Promise<void> {
  apply(unwrapIpcResult(await ipcCallResult("keychain", "open", undefined)));
}
