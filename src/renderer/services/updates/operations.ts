import i18next from "i18next";
import { gt, valid } from "semver";
import { isUnderWay, type UpdateStatus } from "../../../shared/updates/status";
import { dismissToast, showToast, type ToastInput } from "../../components/ui/toast";
import { ipcCallResult, ipcListen } from "../../ipc/client";
import { useUpdatesStore } from "../../state/stores/updates";
import { updateCheckFailedMessage } from "./update-check-failure";

type NewerStatus = Extract<UpdateStatus, { kind: "newer" }>;
type InstallStep = Extract<UpdateStatus, { kind: "downloading" | "verifying" | "ready" }>;

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

export function checkForUpdates(): void {
  const store = useUpdatesStore.getState();
  const before = store.status;
  store.applyStatus({ kind: "checking", trigger: "manual" });
  void ipcCallResult("updates", "check", { trigger: "manual" }).then((result) => {
    if (result.ok) return;
    const now = useUpdatesStore.getState();
    now.endCheck();
    if (now.status?.kind === "checking") now.restoreStatus(before);
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

function replacesStaged(step: InstallStep, latest: string): boolean {
  return (
    step.kind === "ready" &&
    valid(latest) !== null &&
    valid(step.version) !== null &&
    gt(latest, step.version)
  );
}

function announceInstallStep(step: InstallStep): void {
  switch (step.kind) {
    case "downloading":
      showUpdateToast({
        kind: "info",
        message: i18next.t("common:updates.downloading", { version: step.version }),
        durationMs: 3000,
      });
      return;
    case "verifying":
      showUpdateToast({
        kind: "info",
        message: i18next.t("common:updates.verifying", { version: step.version }),
        durationMs: 3000,
      });
      return;
    case "ready":
      showUpdateToast({
        kind: "info",
        message: i18next.t(
          step.asksForPassword ? "common:updates.readyAsksPassword" : "common:updates.ready",
          { version: step.version },
        ),
        actions: [
          {
            label: i18next.t("common:updates.restart"),
            onAction: () => {
              void ipcCallResult("updates", "restart", undefined);
            },
          },
        ],
      });
      return;
  }
}

function answerNewer(status: NewerStatus): void {
  const asked = status.trigger === "manual";
  const step = useUpdatesStore.getState().status;
  if (!isUnderWay(step)) {
    announceNewer(status, asked);
    return;
  }
  if (!replacesStaged(step, status.latest)) {
    if (asked) announceInstallStep(step);
    return;
  }
  if (!asked) {
    announceNewer(status, false);
    return;
  }
  showUpdateToast({
    kind: "info",
    message: i18next.t("common:updates.downloading", { version: status.latest }),
    durationMs: 3000,
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
        answerNewer(status);
        break;

      case "current": {
        const step = useUpdatesStore.getState().status;
        if (status.trigger === "manual" && isUnderWay(step)) {
          announceInstallStep(step);
        } else if (status.trigger === "manual") {
          showUpdateToast({
            kind: "info",
            message: i18next.t("common:updates.upToDate"),
            durationMs: 3000,
          });
        }
        break;
      }

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
