// src/renderer/components/settings/panels/remote-panel.tsx
//
// The NexusCode account the remote runs on: signing in with Google (in the
// system browser; main waits for it to come back), who the app is signed in
// as, the account password (remote-key-group), and the account's devices,
// each of which can be removed.

import { Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { ServerInfo } from "../../../../../packages/remote-protocol/src/info";
import {
  type RemoteAccountState,
  type RemoteDeviceInfo,
  SIGN_IN_PROVIDERS,
  type SignInProvider,
} from "../../../../shared/remote/account";
import type { RoomState } from "../../../../shared/remote/room";
import { ipcCallResult, ipcListen } from "../../../ipc/client";
import { useRemoteRoom } from "../../../services/remote/room";
import { dateTimeFormat } from "../../../utils/intl-format";
import { Button } from "../../ui/button";
import { showConfirmDialog } from "../../ui/confirm-dialog";
import { PromptDialog } from "../../ui/prompt-dialog";
import { SettingsGroup, SettingsPage, SettingsRow } from "../section";
import { AccountKeyGroup, useAccountKey } from "./remote-key-group";

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

/** The sign-ins the server offers, asked while signed out; Google's alone until it answers. */
function useSignIns(ask: boolean): SignInProvider[] {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  useEffect(() => {
    if (!ask) return;
    let live = true;
    void ipcCallResult("remote", "serverInfo", undefined).then((result) => {
      if (live && result.ok) setInfo(result.value);
    });
    return () => {
      live = false;
    };
  }, [ask]);
  const offered = SIGN_IN_PROVIDERS.filter((p) => info?.signIn.includes(p));
  return offered.length > 0 ? offered : ["google"];
}

export function RemotePanel() {
  const state = useRemoteAccount();
  const key = useAccountKey();
  const room = useRemoteRoom();
  const signIns = useSignIns(state?.status === "signed-out");
  if (!state) return null;
  return (
    <SettingsPage>
      <AccountGroup state={state} signIns={signIns} />
      {state.status === "signed-in" && key && <AccountKeyGroup state={key} />}
      {state.status === "signed-in" && <DevicesGroup thisDevice={state.device.id} room={room} />}
      {state.status === "signed-in" && <DeleteAccountGroup />}
    </SettingsPage>
  );
}

export function AccountGroup({
  state,
  signIns = ["google"],
}: {
  state: RemoteAccountState;
  /** The sign-ins the server offers. */
  signIns?: readonly SignInProvider[];
}) {
  const { t } = useTranslation("settings");
  // Signing in answers once the browser is back; the state says so meanwhile.
  const signIn = (provider: SignInProvider) => void ipcCallResult("remote", "signIn", { provider });
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
          <div className="flex items-center gap-2">
            {signIns.map((provider) => (
              <Button key={provider} size="sm" onClick={() => signIn(provider)}>
                {t(`remote.account.signInWith.${provider}`)}
              </Button>
            ))}
          </div>
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

function DevicesGroup({ thisDevice, room }: { thisDevice: string; room: RoomState | null }) {
  const { t } = useTranslation("settings");
  const [view, setView] = useState<DevicesView>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<RemoteDeviceInfo | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  /** Who is in the room now; this device while it is. */
  const online = (id: string) =>
    id === thisDevice
      ? room?.status === "online"
      : (room?.peers.some((p) => p.id === id && p.online) ?? false);

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

  const rename = async (name: string) => {
    if (!renaming) return;
    setRenameBusy(true);
    const result = await ipcCallResult("remote", "renameDevice", { id: renaming.id, name });
    setRenameBusy(false);
    setRenaming(null);
    if (result.ok || result.kind === "not-found") void load();
    else if (result.kind !== "session-expired") setView({ status: "unavailable" });
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
              online={online(device.id)}
              onRename={() => setRenaming(device)}
              onRemove={() => void remove(device)}
            />
          ))}
        </div>
      )}
      <PromptDialog
        request={
          renaming && {
            title: t("remote.devices.renameTitle", { name: renaming.name }),
            label: t("remote.devices.renameLabel"),
            defaultValue: renaming.name,
            confirmLabel: t("remote.devices.renameConfirm"),
          }
        }
        busy={renameBusy}
        onCancel={() => setRenaming(null)}
        onConfirm={(name) => void rename(name.trim().slice(0, 100))}
      />
    </SettingsGroup>
  );
}

export function DeviceRow({
  device,
  current,
  online = false,
  onRename,
  onRemove,
}: {
  device: RemoteDeviceInfo;
  current: boolean;
  /** In the account's room now. */
  online?: boolean;
  onRename?: () => void;
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
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              online ? "bg-[var(--state-success-fg)]" : "bg-muted-foreground/40",
            )}
            role="img"
            aria-label={online ? t("remote.devices.online") : t("remote.devices.offline")}
            title={online ? t("remote.devices.online") : t("remote.devices.offline")}
          />
          <span className="truncate text-app-body text-foreground">{device.name}</span>
          {current && <span className={tagClass}>{t("remote.devices.current")}</span>}
        </span>
        <span className="truncate text-app-micro text-muted-foreground">
          {seen ? `${platform} · ${seen}` : platform}
        </span>
      </div>
      {onRename && (
        <button
          type="button"
          aria-label={t("remote.devices.rename", { name: device.name })}
          title={t("remote.devices.rename", { name: device.name })}
          onClick={onRename}
          className={iconButtonClass}
        >
          <Pencil className="size-3.5" aria-hidden="true" />
        </button>
      )}
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

/** Deleting the account on the server, after asking: every device is signed out. */
export function DeleteAccountGroup() {
  const { t } = useTranslation("settings");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    const ok = await showConfirmDialog({
      title: t("remote.delete.confirm.title"),
      description: t("remote.delete.confirm.description"),
      confirmLabel: t("remote.delete.confirm.confirm"),
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    setError(false);
    const result = await ipcCallResult("remote", "deleteAccount", undefined);
    setBusy(false);
    // Deleted: the account's state goes to signed out, and this group with it.
    if (!result.ok && result.kind !== "session-expired") setError(true);
  };
  return (
    <SettingsGroup title={t("remote.delete.title")}>
      <SettingsRow
        label={t("remote.delete.label")}
        description={
          error ? (
            <span className="text-destructive" role="alert">
              {t("remote.delete.failed")}
            </span>
          ) : (
            t("remote.delete.description")
          )
        }
      >
        <Button variant="destructive" size="sm" onClick={() => void remove()} disabled={busy}>
          {t("remote.delete.button")}
        </Button>
      </SettingsRow>
    </SettingsGroup>
  );
}
