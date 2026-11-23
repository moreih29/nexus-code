import i18next from "i18next";
import type { UpdateStatus } from "../../../shared/updates/status";
import { dismissToast, showToast, type ToastInput } from "../../components/ui/toast";
import { ipcCallResult, ipcListen } from "../../ipc/client";
import { useUpdatesStore } from "../../state/stores/updates";
import { updateCheckFailedMessage } from "./update-check-failure";

type NewerStatus = Extract<UpdateStatus, { kind: "newer" }>;

let updateToastId: number | undefined;

function showUpdateToast(input: ToastInput): void {
  if (updateToastId !== undefined) dismissToast(updateToastId);
  updateToastId = showToast(input);
}

export function installUpdate(version: string): void {
  const store = useUpdatesStore.getState();
  const before = store.status;
  store.applyStatus({ kind: "downloading", version });
  void ipcCallResult("updates", "install", undefined).then((result) => {
    if (result.ok) return;
    const now = useUpdatesStore.getState();
    if (now.status?.kind === "downloading" && now.status.version === version) {
      now.restoreStatus(before);
    }
  });
}

export function skipVersion(version: string): void {
  useUpdatesStore.getState().setIgnoredVersion(version);
  void ipcCallResult("updates", "setIgnoredVersion", { version });
}

function announceNewer(status: NewerStatus, asked: boolean): void {
  const store = useUpdatesStore.getState();
  const { latest, releaseUrl, canInstall } = status;
  if (!asked && (latest === store.ignoredVersion || latest === store.announcedVersion)) return;
  if (latest !== store.announcedVersion) {
    store.setAnnouncedVersion(latest);
    void ipcCallResult("appState", "set", { announcedUpdateVersion: latest });
  }
  showUpdateToast({
    kind: "info",
    message: i18next.t("common:updates.available", { version: latest }),
    actions: [
      canInstall
        ? {
            label: i18next.t("common:updates.install"),
            onAction: () => installUpdate(latest),
          }
        : {
            label: i18next.t("common:updates.download"),
            onAction: () => {
              void ipcCallResult("updates", "openReleasePage", { url: releaseUrl });
            },
          },
      {
        label: i18next.t("common:updates.skipVersion"),
        onAction: () => skipVersion(latest),
      },
    ],
  });
}

type Unsubscribe = () => void;

let activeUnsub: Unsubscribe | null = null;

export function initUpdatesSubscriptions(): void {
  if (activeUnsub !== null) {
    activeUnsub();
    activeUnsub = null;
  }

  const unsubscribeStatus = ipcListen("updates", "statusChanged", (status) => {
    useUpdatesStore.getState().applyStatus(status);
    switch (status.kind) {
      case "checking":
        showUpdateToast({
          kind: "info",
          message: i18next.t("common:updates.checking"),
          durationMs: 3000,
        });
        break;

      case "newer":
        announceNewer(status, status.trigger === "manual");
        break;

      case "current":
        if (status.trigger === "manual") {
          showUpdateToast({
            kind: "info",
            message: i18next.t("common:updates.upToDate"),
            durationMs: 3000,
          });
        }
        break;

      case "error":
        if (status.trigger === "manual") {
          showUpdateToast({
            kind: "error",
            message: updateCheckFailedMessage(status),
          });
        }
        break;

      case "downloading":
      case "verifying":
      case "ready":
        break;

      case "installFailed": {
        const { releaseUrl } = status;
        showUpdateToast({
          kind: "error",
          message: i18next.t("common:updates.installFailed"),
          actions: [
            {
              label: i18next.t("common:updates.openReleasePage"),
              onAction: () => {
                void ipcCallResult("updates", "openReleasePage", { url: releaseUrl });
              },
            },
          ],
        });
        break;
      }
    }
  });
  const unsubscribeProgress = ipcListen("updates", "progress", (progress) => {
    useUpdatesStore.getState().applyProgress(progress);
  });
  activeUnsub = () => {
    unsubscribeStatus();
    unsubscribeProgress();
  };

  void ipcCallResult("updates", "getStatus", undefined).then((result) => {
    if (!result.ok) return;
    const { status, progress } = result.value;
    const store = useUpdatesStore.getState();
    if (status === null || store.status !== null) return;
    store.applyStatus(status);
    if (progress !== null) store.applyProgress(progress);
    if (status.kind === "newer") announceNewer(status, false);
  });
}
