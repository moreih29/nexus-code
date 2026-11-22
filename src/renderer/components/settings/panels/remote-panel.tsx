// src/renderer/components/settings/panels/remote-panel.tsx
//
// The NexusCode account the remote runs on: signing in through the
// system browser with a provider the server offers, who the app is signed in as,
// the account password (remote-key-group), what other devices may do here,
// and the account's devices, each of which can be renamed or removed.

import { Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { PUSH_VERSION } from "../../../../../packages/remote-protocol/src/push";
import type { AccountKeyState } from "../../../../shared/remote/account";
import {
  deviceLabel,
  MAX_DEVICE_ALIAS,
  type RemoteAccountState,
  type RemoteDeviceInfo,
  SIGN_IN_PROVIDERS,
  type SignInProvider,
} from "../../../../shared/remote/account";
import type { RoomState } from "../../../../shared/remote/room";
import { SERVER } from "../../../../shared/remote/server";
import type { PhonePushPolicy, RemoteAgentsPolicy } from "../../../../shared/types/app-state";
import { ipcCallResult } from "../../../ipc/client";
import { useRemoteAccount } from "../../../services/remote/account";
import { useRemoteRoom, useShownRoom } from "../../../services/remote/room";
import { dateTimeFormat } from "../../../utils/intl-format";
import { Button } from "../../ui/button";
import { showConfirmDialog } from "../../ui/confirm-dialog";
import { PromptDialog } from "../../ui/prompt-dialog";
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "../section";
import { SegmentedControl } from "../segmented-control";
import { AccountKeyGroup, keyFailureText, useAccountKey } from "./remote-key-group";
import { OutdatedGroup } from "./remote-outdated";
import { PasswordDialog, type PasswordRequest } from "./remote-password-dialog";
import { VoiceGroup } from "./remote-voice-group";
import { SignInButton } from "./sign-in-buttons";

const iconButtonClass = cn(
  "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center",
  "rounded-(--radius-control) text-muted-foreground transition-colors",
  "hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
  "disabled:pointer-events-none disabled:opacity-40",
);

const tagClass =
  "shrink-0 rounded-(--radius-pill) border border-border px-1.5 text-app-micro text-muted-foreground";

/** The support contact listed for the app in the Store. */
const SUPPORT_PAGE_URL = "https://github.com/moreih29/nexus-code/issues";

const PLATFORMS: Record<string, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
  ios: "iOS",
  android: "Android",
  web: "Web",
};

/** The sign-ins the server advertises while signed out, and whether to ask again. */
function useSignIns(ask: boolean): {
  providers: readonly string[];
  unreachable: boolean;
  retry: () => void;
} {
  const [providers, setProviders] = useState<readonly string[]>([]);
  const [unreachable, setUnreachable] = useState(false);
  const [round, setRound] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` asks again
  useEffect(() => {
    if (!ask) return;
    let live = true;
    void ipcCallResult("remote", "serverInfo", undefined).then((result) => {
      if (!live) return;
      setUnreachable(!result.ok);
      if (result.ok) setProviders(result.value.signIn);
    });
    return () => {
      live = false;
    };
  }, [ask, round]);
  return {
    providers,
    unreachable,
    retry: () => setRound((r) => r + 1),
  };
}

export function RemotePanel() {
  const state = useRemoteAccount();
  const key = useAccountKey();
  // Who is in the room, with a drop shorter than DROP_SHOWN_AFTER_MS left out.
  const room = useShownRoom(useRemoteRoom());
  const signIns = useSignIns(state?.status === "signed-out");
  if (!state) return null;
  return (
    <SettingsPage>
      {room?.status === "outdated" && <OutdatedGroup />}
      <AccountGroup
        state={state}
        signIns={signIns.providers}
        unreachable={signIns.unreachable}
        onRetry={signIns.retry}
      />
      {state.status === "signed-in" && key && <AccountKeyGroup state={key} />}
      {state.status === "signed-in" && <RemoteControlGroup />}
      {state.status === "signed-in" && (
        <DevicesGroup thisDevice={state.device.id} room={room} keyState={key} />
      )}
      {state.status === "signed-in" && <VoiceGroup />}
      {state.status === "signed-in" && <DeleteAccountGroup keyState={key} />}
    </SettingsPage>
  );
}

export function AccountGroup({
  state,
  signIns = [],
  unreachable = false,
  onRetry,
}: {
  state: RemoteAccountState;
  /** The sign-ins advertised by the server, including providers this app may not know. */
  signIns?: readonly string[];
  /** The server did not answer when asked what it offers. */
  unreachable?: boolean;
  onRetry?: () => void;
}) {
  const { t } = useTranslation("settings");
  // Signing in answers once the browser is back; the state says so meanwhile.
  const signIn = (provider?: SignInProvider) =>
    void ipcCallResult("remote", "signIn", provider ? { provider } : undefined);
  const cancel = () => void ipcCallResult("remote", "cancelSignIn", undefined);
  const signOut = () => void ipcCallResult("remote", "signOut", undefined);
  const offered = SIGN_IN_PROVIDERS.filter((provider) => signIns.includes(provider));
  const providers: readonly SignInProvider[] = offered.length > 0 ? offered : ["google"];
  const failure =
    state.status === "signed-out" && state.failure && state.failure !== "cancelled"
      ? state.failure
      : unreachable
        ? "unreachable"
        : undefined;

  return (
    <SettingsGroup
      title={t("remote.account.title")}
      description={state.status === "signed-in" ? undefined : t("remote.account.description")}
    >
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
        <SettingsSection
          label={t("remote.account.signedOut")}
          action={
            <div className="flex flex-wrap justify-end gap-2 empty:hidden">
              {failure === "pending_approval" && (
                <Button variant="outline" size="sm" onClick={() => signIn()}>
                  {t("remote.account.checkAgain")}
                </Button>
              )}
              {failure === "suspended" && (
                <Button variant="outline" size="sm" asChild>
                  <a href={SUPPORT_PAGE_URL} target="_blank" rel="noopener noreferrer">
                    {t("remote.account.openSupportPage")}
                  </a>
                </Button>
              )}
              {unreachable && onRetry && (
                <Button variant="outline" size="sm" onClick={onRetry}>
                  {t("remote.account.retry")}
                </Button>
              )}
            </div>
          }
          description={
            failure && (
              <span
                className={
                  failure === "pending_approval" ? "text-muted-foreground" : "text-destructive"
                }
                role="alert"
              >
                {t(`remote.account.failure.${failure}`)}
              </span>
            )
          }
        >
          <div
            className={cn(
              "gap-2",
              providers.includes("apple") ? "grid w-fit max-w-full" : "flex flex-wrap items-center",
            )}
          >
            {providers.map((provider) => (
              <SignInButton key={provider} provider={provider} onClick={() => signIn(provider)} />
            ))}
          </div>
        </SettingsSection>
      )}
      {/* The released app's own server goes without saying. */}
      {state.server !== SERVER && (
        <p className="text-app-micro text-muted-foreground">
          {t("remote.account.server", { server: state.server })}
        </p>
      )}
    </SettingsGroup>
  );
}

type DevicesView =
  | { status: "loading" }
  | { status: "ready"; devices: RemoteDeviceInfo[] }
  | { status: "unavailable" };

/**
 * Whether the account's other devices may control this computer's chats:
 * off, they only look.
 */
export function RemoteControlSwitch() {
  const { t } = useTranslation("settings");
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void ipcCallResult("remote", "allowControl", undefined).then((result) => {
      if (live && result.ok) setAllowed(result.value);
    });
    return () => {
      live = false;
    };
  }, []);
  return (
    <SettingsSwitch
      label={t("remote.control.label")}
      description={t("remote.control.description")}
      checked={allowed ?? false}
      disabled={allowed === null}
      onChange={(next) => {
        setAllowed(next);
        void ipcCallResult("remote", "setAllowControl", { allowed: next });
      }}
    />
  );
}

/**
 * Whether the account's other devices may control this computer's
 * terminals: type into them, open and close them. Off, they only read them.
 */
export function RemoteTerminalSwitch() {
  const { t } = useTranslation("settings");
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void ipcCallResult("remote", "allowTerminal", undefined).then((result) => {
      if (live && result.ok) setAllowed(result.value);
    });
    return () => {
      live = false;
    };
  }, []);
  return (
    <SettingsSwitch
      label={t("remote.terminal.label")}
      description={t("remote.terminal.description")}
      checked={allowed ?? false}
      disabled={allowed === null}
      onChange={(next) => {
        setAllowed(next);
        void ipcCallResult("remote", "setAllowTerminal", { allowed: next });
      }}
    />
  );
}

/** What agents on the user's other computers may do here through their nexus command. */
export function RemoteAgentsPolicyRow() {
  const { t } = useTranslation("settings");
  const [policy, setPolicy] = useState<RemoteAgentsPolicy | null>(null);
  useEffect(() => {
    let live = true;
    void ipcCallResult("remote", "agentsPolicy", undefined).then((result) => {
      if (live && result.ok) setPolicy(result.value);
    });
    return () => {
      live = false;
    };
  }, []);
  const label = t("remote.agents.label");
  return (
    <SettingsRow label={label} description={t("remote.agents.description")}>
      <SegmentedControl
        options={(["ask", "allow", "deny"] as const).map((value) => ({
          value,
          label: t(`remote.agents.${value}`),
        }))}
        value={policy ?? "ask"}
        onChange={(next) => {
          setPolicy(next);
          void ipcCallResult("remote", "setAgentsPolicy", { policy: next });
        }}
        label={label}
        disabled={policy === null}
      />
    </SettingsRow>
  );
}

function PhonePushPolicyRow() {
  const { t } = useTranslation("settings");
  const [policy, setPolicy] = useState<PhonePushPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    void Promise.all([
      ipcCallResult("remote", "serverInfo", undefined),
      ipcCallResult("remote", "phonePushPolicy", undefined),
    ])
      .then(([server, setting]) => {
        if (live && server.ok && server.value.push?.version === PUSH_VERSION && setting.ok) {
          setPolicy(setting.value);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  if (policy === null) return null;
  const label = t("remote.phonePush.label");
  return (
    <SettingsRow
      label={label}
      description={<span className="break-keep">{t("remote.phonePush.description")}</span>}
    >
      <SegmentedControl
        label={label}
        options={(["away", "always", "off"] as const).map((value) => ({
          value,
          label: t(`remote.phonePush.${value}`),
        }))}
        value={policy}
        disabled={saving}
        onChange={(next) => {
          setSaving(true);
          void ipcCallResult("remote", "setPhonePushPolicy", { policy: next })
            .then((result) => {
              if (result.ok) setPolicy(result.value);
            })
            .catch(() => {})
            .finally(() => setSaving(false));
        }}
      />
    </SettingsRow>
  );
}

/** What the account's other devices may do here: chats, terminals, and their agents. */
export function RemoteControlGroup() {
  const { t } = useTranslation("settings");
  return (
    <SettingsGroup title={t("remote.controlTitle")}>
      <RemoteControlSwitch />
      <RemoteTerminalSwitch />
      <RemoteAgentsPolicyRow />
      <PhonePushPolicyRow />
    </SettingsGroup>
  );
}

/** Whether the server asks for the account password before removing a device or deleting the account: once the account has a key. */
function asksPassword(key: AccountKeyState | null): boolean {
  return key?.status === "unlocked" || key?.status === "locked";
}

function DevicesGroup({
  thisDevice,
  room,
  keyState,
}: {
  thisDevice: string;
  room: RoomState | null;
  keyState: AccountKeyState | null;
}) {
  const { t } = useTranslation("settings");
  const [passwordRequest, setPasswordRequest] = useState<PasswordRequest | null>(null);
  const [view, setView] = useState<DevicesView>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [naming, setNaming] = useState<RemoteDeviceInfo | null>(null);
  const [aliasBusy, setAliasBusy] = useState(false);
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

  // A device signed in since the list came: in the room before it is in the list.
  const known = view.status === "ready" ? view.devices : null;
  const newcomer = room?.peers.some((p) => !known?.some((d) => d.id === p.id)) ?? false;
  useEffect(() => {
    if (known && newcomer) void load();
  }, [known, newcomer, load]);

  const remove = async (device: RemoteDeviceInfo) => {
    const self = device.id === thisDevice;
    // Another device: the account key is rotated, with the password.
    if (!self && asksPassword(keyState)) {
      setPasswordRequest({
        title: t("remote.devices.removeConfirm.title", { name: deviceLabel(device) }),
        description: t("remote.devices.removeConfirm.descriptionRotate"),
        confirmLabel: t("remote.devices.removeConfirm.confirm"),
        destructive: true,
        run: async (password) => {
          const result = await ipcCallResult("remote", "removeDevice", {
            id: device.id,
            password,
          });
          if (result.ok || result.kind === "not-found") {
            void load();
            return null;
          }
          return keyFailureText(t, result.kind);
        },
      });
      return;
    }
    const ok = await showConfirmDialog({
      title: t("remote.devices.removeConfirm.title", { name: deviceLabel(device) }),
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

  const giveAlias = async (alias: string) => {
    if (!naming) return;
    setAliasBusy(true);
    const result = await ipcCallResult("remote", "setDeviceAlias", {
      id: naming.id,
      alias: alias || null,
    });
    setAliasBusy(false);
    setNaming(null);
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
              onAlias={() => setNaming(device)}
              onRemove={() => void remove(device)}
            />
          ))}
        </div>
      )}
      <PromptDialog
        request={
          naming && {
            title: t("remote.devices.aliasTitle", { name: deviceLabel(naming) }),
            description: t("remote.devices.aliasDescription", { name: naming.name }),
            label: t("remote.devices.aliasLabel"),
            placeholder: naming.name,
            defaultValue: naming.alias ?? "",
            confirmLabel: t("remote.devices.aliasConfirm"),
            allowEmpty: true,
          }
        }
        busy={aliasBusy}
        onCancel={() => setNaming(null)}
        onConfirm={(alias) => void giveAlias(alias.trim().slice(0, MAX_DEVICE_ALIAS))}
      />
      <PasswordDialog request={passwordRequest} onClose={() => setPasswordRequest(null)} />
    </SettingsGroup>
  );
}

export function DeviceRow({
  device,
  current,
  online = false,
  onAlias,
  onRemove,
}: {
  device: RemoteDeviceInfo;
  current: boolean;
  /** In the account's room now. */
  online?: boolean;
  /** Gives it an alias, or takes it away. */
  onAlias?: () => void;
  onRemove: () => void;
}) {
  const { t, i18n } = useTranslation("settings");
  const platform = PLATFORMS[device.platform] ?? device.platform;
  const label = deviceLabel(device);
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
          <span className="truncate text-app-body text-foreground">{label}</span>
          {current && <span className={tagClass}>{t("remote.devices.current")}</span>}
        </span>
        <span className="truncate text-app-micro text-muted-foreground">
          {[device.alias ? device.name : null, platform, seen].filter(Boolean).join(" · ")}
        </span>
      </div>
      {onAlias && (
        <button
          type="button"
          aria-label={t("remote.devices.alias", { name: label })}
          title={t("remote.devices.alias", { name: label })}
          onClick={onAlias}
          className={iconButtonClass}
        >
          <Pencil className="size-3.5" aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        aria-label={t("remote.devices.remove", { name: label })}
        title={t("remote.devices.remove", { name: label })}
        onClick={onRemove}
        className={iconButtonClass}
      >
        <Trash2 className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

/** Deleting the account on the server, after asking: every device is signed out. */
export function DeleteAccountGroup({ keyState }: { keyState: AccountKeyState | null }) {
  const { t } = useTranslation("settings");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [passwordRequest, setPasswordRequest] = useState<PasswordRequest | null>(null);
  const remove = async () => {
    if (asksPassword(keyState)) {
      setPasswordRequest({
        title: t("remote.delete.confirm.title"),
        description: t("remote.delete.confirm.descriptionPassword"),
        confirmLabel: t("remote.delete.confirm.confirm"),
        destructive: true,
        run: async (password) => {
          const result = await ipcCallResult("remote", "deleteAccount", { password });
          if (result.ok || result.kind === "session-expired") return null;
          return result.kind === "unavailable"
            ? t("remote.delete.failed")
            : keyFailureText(t, result.kind);
        },
      });
      return;
    }
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
    <SettingsGroup>
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
      <PasswordDialog request={passwordRequest} onClose={() => setPasswordRequest(null)} />
    </SettingsGroup>
  );
}
