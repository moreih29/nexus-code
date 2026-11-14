// src/renderer/components/settings/panels/remote-pairing.tsx
//
// Pairing through a QR code, on the Remote page: this device shows a code
// that another device scans. A device holding the account key gives it to a
// new phone that scans it, once the user allows it here; a device without
// it takes it from a phone holding it, instead of the password.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PairingState } from "../../../../shared/remote/pairing";
import { ipcCallResult, ipcListen } from "../../../ipc/client";
import { Button } from "../../ui/button";
import { SettingsRow } from "../section";

/** The pairing's state from main, kept up as it changes. */
export function usePairing(): PairingState {
  const [state, setState] = useState<PairingState>({ status: "idle" });
  useEffect(() => {
    let live = true;
    const off = ipcListen("remote", "pairChanged", (next) => setState(next));
    void ipcCallResult("remote", "pairing", undefined).then((result) => {
      if (live && result.ok) setState(result.value);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}

/** Seconds left until `at`, counted down each second. */
function useSecondsLeft(at: number | null): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (at === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [at]);
  return at === null ? 0 : Math.max(0, Math.ceil((at - now) / 1000));
}

export function PairingRow({ giving }: { giving: boolean }) {
  const { t } = useTranslation("settings");
  const state = usePairing();
  const expiresAt = state.status === "showing" || state.status === "asked" ? state.expiresAt : null;
  const left = useSecondsLeft(expiresAt);
  const open = state.status === "showing" || state.status === "asked";

  // Leaving the page drops a code still shown, and its socket.
  useEffect(
    () => () => {
      void ipcCallResult("remote", "pairStop", undefined);
    },
    [],
  );

  const start = () => void ipcCallResult("remote", "pairStart", undefined);
  const stop = () => void ipcCallResult("remote", "pairStop", undefined);
  const answer = (allow: boolean) => void ipcCallResult("remote", "pairAnswer", { allow });

  if (state.status === "showing") {
    return (
      <div className="flex items-start gap-4" data-testid="pairing-code">
        <img
          src={state.qr}
          alt={t("remote.pair.qrAlt")}
          className="size-40 shrink-0 rounded-(--radius-control) bg-white p-1"
        />
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-app-ui-sm text-foreground">
            {state.giving ? t("remote.pair.showingGive") : t("remote.pair.showingTake")}
          </p>
          <p className="text-app-ui-sm text-muted-foreground">
            {t("remote.pair.expires", { seconds: left })}
          </p>
          <div>
            <Button variant="outline" size="sm" onClick={stop}>
              {t("remote.account.cancel")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (state.status === "asked") {
    const name = state.deviceName ?? state.deviceId;
    return (
      <SettingsRow
        label={t("remote.pair.askedTitle", { name })}
        description={t("remote.pair.askedDescription", { seconds: left })}
      >
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => answer(false)}>
            {t("remote.pair.deny")}
          </Button>
          <Button size="sm" onClick={() => answer(true)}>
            {t("remote.pair.allow")}
          </Button>
        </div>
      </SettingsRow>
    );
  }

  const result =
    state.status === "done"
      ? state.deviceName
        ? t("remote.pair.doneGive", { name: state.deviceName })
        : t("remote.pair.done")
      : state.status === "failed"
        ? t(`remote.pair.failed.${state.reason}`)
        : null;

  return (
    <SettingsRow
      label={giving ? t("remote.pair.giveLabel") : t("remote.pair.takeLabel")}
      description={
        result ? (
          <span
            className={state.status === "failed" ? "text-destructive" : undefined}
            role={state.status === "failed" ? "alert" : undefined}
          >
            {result}
          </span>
        ) : giving ? (
          t("remote.pair.giveDescription")
        ) : (
          t("remote.pair.takeDescription")
        )
      }
    >
      <Button variant="outline" size="sm" onClick={start} disabled={open}>
        {t("remote.pair.show")}
      </Button>
    </SettingsRow>
  );
}
