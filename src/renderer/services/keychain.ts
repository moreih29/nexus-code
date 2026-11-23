// The macOS keychain the app's sealed files open with, as the windows see it
// (main/features/keychain): the question asked once before it is read, the
// toast while macOS asks for the login password, and the settings' button.

import i18next from "i18next";
import { create } from "zustand";
import { showConfirmDialog } from "@/components/ui/confirm-dialog";
import { dismissToast, showToast } from "@/components/ui/toast";
import { ipcCallResult, ipcListen, unwrapIpcResult } from "@/ipc/client";
import { useReleaseNotesStore } from "@/state/stores/release-notes";
import type { KeychainStatus } from "../../shared/keychain";

export const useKeychain = create<{ status: KeychainStatus | null }>(() => ({ status: null }));

/** The question waits for the release notes to close, as for any other open question. */
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

/** What the keychain keeps, in the app's words: "원격 로그인, 기억한 목소리". */
export function keychainItemsText(status: KeychainStatus): string {
  return status.items.map((item) => i18next.t(`common:keychain.items.${item}`)).join(", ");
}

let asking: Promise<void> | undefined;

/** Asks before the keychain is read, in one window only: the others wait for its answer. */
function ask(): Promise<void> {
  asking ??= (async () => {
    await releaseNotesClosed();
    const { prompt, status } = unwrapIpcResult(
      await ipcCallResult("keychain", "claimPrompt", undefined),
    );
    apply(status);
    if (!prompt) return;
    const open = await showConfirmDialog({
      title: i18next.t("common:keychain.prompt.title"),
      description: i18next.t("common:keychain.prompt.description", {
        items: keychainItemsText(status),
      }),
      hint: i18next.t("common:keychain.prompt.hint"),
      cancelLabel: i18next.t("common:keychain.prompt.later"),
      confirmLabel: i18next.t("common:keychain.prompt.continue"),
    });
    apply(unwrapIpcResult(await ipcCallResult("keychain", "answer", { open })));
  })()
    .catch(() => {})
    .finally(() => {
      asking = undefined;
    });
  return asking;
}

let toast: number | undefined;

/** While macOS asks for the password: what to choose there, until the call ends. */
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
}

/** Follows the keychain for this window; mounted once (KeychainRoot). */
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

/** The settings' button: opens the keychain now, and macOS may ask. */
export async function openKeychain(): Promise<void> {
  apply(unwrapIpcResult(await ipcCallResult("keychain", "open", undefined)));
}
