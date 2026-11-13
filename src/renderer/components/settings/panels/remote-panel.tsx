// src/renderer/components/settings/panels/remote-panel.tsx
//
// The NexusCode account the remote runs on: signing in with Google (in the
// system browser; main waits for it to come back), who the app is signed in
// as, and the account's devices, each of which can be removed.

import { RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { RemoteAccountState, RemoteDeviceInfo } from "../../../../shared/remote/account";
import { ipcCallResult, ipcListen } from "../../../ipc/client";
import { dateTimeFormat } from "../../../utils/intl-format";
import { Button } from "../../ui/button";
import { showConfirmDialog } from "../../ui/confirm-dialog";
import { SettingsGroup, SettingsPage, SettingsRow } from "../section";

const iconButtonClass = cn(
  "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center",
  "rounded-(--radius-control) text-muted-foreground transition-colors",
  "hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
  "disabled:pointer-events-none disabled:opacity-40",
);

const tagClass =
  "shrink-0 rounded-(--radius-pill) border border-border px-1.5 text-app-micro text-muted-foreground";

const PLATFORMS: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

/** The account's state from main, kept up as it changes. */
function useRemoteAccount(): RemoteAccountState | null {
  const [state, setState] = useState<RemoteAccountState | null>(null);
  useEffect(() => {
    let live = true;
    const off = ipcListen("remote", "accountChanged", (next) => setState(next));
    void ipcCallResult("remote", "account", undefined).then((result) => {
      if (live && result.ok) setState((now) => now ?? result.value);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}

export function RemotePanel() {
  const state = useRemoteAccount();
  if (!state) return null;
  return (
    <SettingsPage>
      <AccountGroup state={state} />
      {state.status === "signed-in" && <DevicesGroup thisDevice={state.device.id} />}
    </SettingsPage>
  );
}

export function AccountGroup({ state }: { state: RemoteAccountState }) {
  const { t } = useTranslation("settings");
  // Signing in answers once the browser is back; the state says so meanwhile.
  const signIn = () => void ipcCallResult("remote", "signIn", undefined);
  const cancel = () => void ipcCallResult("remote", "cancelSignIn", undefined);
  const signOut = () => void ipcCallResult("remote", "signOut", undefined);
  const failure =
    state.status === "signed-out" && state.failure && state.failure !== "cancelled"
      ? state.failure
      : undefined;

  return (
    <SettingsGroup title={t("remote.account.title")} description={t("remote.account.description")}>
      {state.status === "signed-in" ? (
        <SettingsRow label={state.user.name || state.user.email} description={state.user.email}>
          <Button variant="outline" size="sm" onClick={signOut}>
            {t("remote.account.signOut")}
          </Button>
        </SettingsRow>
      ) : state.status === "signing-in" ? (
        <SettingsRow label={t("remote.account.signingIn")}>
          <Button variant="outline" size="sm" onClick={cancel}>
            {t("remote.account.cancel")}
          </Button>
        </SettingsRow>
      ) : (
        <SettingsRow
          label={t("remote.account.signedOut")}
          description={
            failure && (
              <span className="text-destructive" role="alert">
                {t(`remote.account.failure.${failure}`)}
              </span>
            )
          }
        >
          <Button size="sm" onClick={signIn}>
            {t("remote.account.signIn")}
          </Button>
        </SettingsRow>
      )}
      <p className="text-app-micro text-muted-foreground">
        {t("remote.account.server", { server: state.server })}
      </p>
    </SettingsGroup>
  );
}

type DevicesView =
  | { status: "loading" }
  | { status: "ready"; devices: RemoteDeviceInfo[] }
  | { status: "unavailable" };

function DevicesGroup({ thisDevice }: { thisDevice: string }) {
  const { t } = useTranslation("settings");
  const [view, setView] = useState<DevicesView>({ status: "loading" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    const result = await ipcCallResult("remote", "devices", undefined);
    setBusy(false);
    // Signed out meanwhile: the account's state says so, and this group goes.
    if (result.ok) setView({ status: "ready", devices: result.value });
    else if (result.kind !== "session-expired") setView({ status: "unavailable" });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (device: RemoteDeviceInfo) => {
    const self = device.id === thisDevice;
    const ok = await showConfirmDialog({
      title: t("remote.devices.removeConfirm.title", { name: device.name }),
      description: self
        ? t("remote.devices.removeConfirm.descriptionSelf")
        : t("remote.devices.removeConfirm.description"),
      confirmLabel: t("remote.devices.removeConfirm.confirm"),
      variant: "destructive",
    });
    if (!ok) return;
    const result = await ipcCallResult("remote", "removeDevice", { id: device.id });
    if (!self && (result.ok || result.kind === "not-found")) void load();
    else if (!result.ok && result.kind !== "session-expired") setView({ status: "unavailable" });
  };

  return (
    <SettingsGroup
      title={t("remote.devices.title")}
      action={
        <button
          type="button"
          aria-label={t("remote.devices.refresh")}
          title={t("remote.devices.refresh")}
          onClick={() => void load()}
          disabled={busy}
          className={iconButtonClass}
        >
          <RefreshCw className={cn("size-3.5", busy && "animate-spin")} aria-hidden="true" />
        </button>
      }
    >
      {view.status === "unavailable" && (
        <p className="text-app-ui-sm text-destructive" role="alert">
          {t("remote.devices.unavailable")}
        </p>
      )}
      {view.status === "ready" && view.devices.length === 0 && (
        <p className="text-app-ui-sm text-muted-foreground">{t("remote.devices.empty")}</p>
      )}
      {view.status === "ready" && view.devices.length > 0 && (
        <div className="flex flex-col gap-0.5" data-testid="remote-devices">
          {view.devices.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              current={device.current ?? device.id === thisDevice}
              onRemove={() => void remove(device)}
            />
          ))}
        </div>
      )}
    </SettingsGroup>
  );
}

export function DeviceRow({
  device,
  current,
  onRemove,
}: {
  device: RemoteDeviceInfo;
  current: boolean;
  onRemove: () => void;
}) {
  const { t, i18n } = useTranslation("settings");
  const platform = PLATFORMS[device.platform] ?? device.platform;
  const seen =
    device.lastSeenAt !== undefined
      ? t("remote.devices.lastSeen", {
          when: dateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(
            device.lastSeenAt,
          ),
        })
      : undefined;

  return (
    <div
      className="flex items-center gap-3 rounded-(--radius-control) px-2 py-1.5 hover:bg-[var(--state-hover-bg)]"
      data-testid="remote-device-row"
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-app-body text-foreground">{device.name}</span>
          {current && <span className={tagClass}>{t("remote.devices.current")}</span>}
        </span>
        <span className="truncate text-app-micro text-muted-foreground">
          {seen ? `${platform} · ${seen}` : platform}
        </span>
      </div>
      <button
        type="button"
        aria-label={t("remote.devices.remove", { name: device.name })}
        title={t("remote.devices.remove", { name: device.name })}
        onClick={onRemove}
        className={iconButtonClass}
      >
        <Trash2 className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
