// src/renderer/components/settings/panels/remote-key-group.tsx
//
// The account password, on the Remote page: what the account's devices
// seal what they send each other with is the account key, which the server
// keeps locked with this password. Here the first device sets it, another
// types it to take the key, and a device holding the key changes it, or
// resets it when it is forgotten or a device was lost.

import { type FormEvent, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import {
  type AccountKeyState,
  KEY_FAILURES,
  type KeyFailure,
  MIN_PASSWORD_LENGTH,
} from "../../../../shared/remote/account";
import { ipcCallResult, ipcListen } from "../../../ipc/client";
import { Button } from "../../ui/button";
import { showConfirmDialog } from "../../ui/confirm-dialog";
import { SettingsGroup, SettingsRow } from "../section";

const inputClass = cn(
  "w-full rounded-(--radius-control) border border-border bg-background px-2 py-1",
  "text-app-body text-foreground outline-none placeholder:text-muted-foreground",
  "focus-visible:ring-1 focus-visible:ring-ring",
);

/** The account key's state from main, kept up as it changes. */
export function useAccountKey(): AccountKeyState | null {
  const [state, setState] = useState<AccountKeyState | null>(null);
  useEffect(() => {
    let live = true;
    const off = ipcListen("remote", "keyChanged", (next) => setState(next));
    void ipcCallResult("remote", "key", undefined).then((result) => {
      if (live && result.ok) setState((now) => now ?? result.value);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}

type Mode = "idle" | "change" | "reset";

export function AccountKeyGroup({ state }: { state: AccountKeyState }) {
  const { t } = useTranslation("settings");
  const [mode, setMode] = useState<Mode>("idle");
  // A state that changed (a flow done, a reset elsewhere) closes the form it no longer fits.
  const [seen, setSeen] = useState(state.status);
  if (seen !== state.status) {
    setSeen(state.status);
    setMode("idle");
  }
  if (state.status === "signed-out") return null;
  const idle = () => setMode("idle");

  return (
    <SettingsGroup title={t("remote.key.title")} description={t("remote.key.description")}>
      {state.status === "checking" && (
        <SettingsRow label={t("remote.key.checking")}>{null}</SettingsRow>
      )}
      {state.status === "unavailable" && (
        <SettingsRow
          label={t("remote.key.unavailable")}
          description={state.retryAt ? t("remote.key.retryLater") : undefined}
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => void ipcCallResult("remote", "refreshKey", undefined)}
          >
            {t("remote.key.retry")}
          </Button>
        </SettingsRow>
      )}
      {state.status === "missing" && (
        <>
          <p className="text-app-ui-sm text-muted-foreground">
            {t("remote.key.missing", { count: MIN_PASSWORD_LENGTH })}
          </p>
          <PasswordForm kind="create" />
        </>
      )}
      {state.status === "locked" && mode === "idle" && (
        <>
          <p className="text-app-ui-sm text-muted-foreground">{t("remote.key.locked")}</p>
          <PasswordForm kind="unlock" onForgot={() => setMode("reset")} />
        </>
      )}
      {state.status === "unlocked" && mode === "idle" && (
        <SettingsRow
          label={t("remote.key.unlocked")}
          description={t("remote.key.version", { kid: state.kid })}
        >
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setMode("change")}>
              {t("remote.key.change")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setMode("reset")}>
              {t("remote.key.reset")}
            </Button>
          </div>
        </SettingsRow>
      )}
      {state.status === "unlocked" && mode === "change" && (
        <PasswordForm kind="change" onCancel={idle} onDone={idle} />
      )}
      {(state.status === "unlocked" || state.status === "locked") && mode === "reset" && (
        <>
          <p className="text-app-ui-sm text-muted-foreground">{t("remote.key.resetExplained")}</p>
          <PasswordForm kind="reset" onCancel={idle} onDone={idle} />
        </>
      )}
    </SettingsGroup>
  );
}

type FormKind = "create" | "unlock" | "change" | "reset";
type Field = "password" | "current" | "next" | "confirm";

const FIELDS: Record<FormKind, readonly Field[]> = {
  create: ["next", "confirm"],
  unlock: ["password"],
  change: ["current", "next", "confirm"],
  reset: ["next", "confirm"],
};

const EMPTY: Record<Field, string> = { password: "", current: "", next: "", confirm: "" };

/** Sends the form's flow to main: the new state, or its KeyFailure as the kind. */
function send(kind: FormKind, values: Record<Field, string>) {
  switch (kind) {
    case "create":
      return ipcCallResult("remote", "createKey", { password: values.next });
    case "unlock":
      return ipcCallResult("remote", "unlockKey", { password: values.password });
    case "change":
      return ipcCallResult("remote", "changePassword", {
        current: values.current,
        next: values.next,
      });
    case "reset":
      return ipcCallResult("remote", "resetKey", { password: values.next });
  }
}

function failureOf(kind: string): KeyFailure | "failed" {
  return KEY_FAILURES.find((f) => f === kind) ?? "failed";
}

export function PasswordForm({
  kind,
  onCancel,
  onDone,
  onForgot,
}: {
  kind: FormKind;
  onCancel?: () => void;
  /** Told once the flow went through: a change keeps the state as it was, so nothing else closes the form. */
  onDone?: () => void;
  onForgot?: () => void;
}) {
  const { t } = useTranslation("settings");
  const id = useId();
  const fields = FIELDS[kind];
  const [values, setValues] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (fields.includes("next")) {
      if ([...values.next.normalize("NFKC")].length < MIN_PASSWORD_LENGTH) {
        setError(t("remote.key.failure.too-short", { count: MIN_PASSWORD_LENGTH }));
        return;
      }
      if (values.next !== values.confirm) {
        setError(t("remote.key.mismatch"));
        return;
      }
    }
    if (
      kind === "reset" &&
      !(await showConfirmDialog({
        title: t("remote.key.resetConfirm.title"),
        description: t("remote.key.resetConfirm.description"),
        confirmLabel: t("remote.key.resetConfirm.confirm"),
        variant: "destructive",
      }))
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    const result = await send(kind, values);
    setBusy(false);
    if (result.ok) {
      setValues(EMPTY);
      onDone?.();
      return;
    }
    setError(t(`remote.key.failure.${failureOf(result.kind)}`, { count: MIN_PASSWORD_LENGTH }));
  };

  return (
    <form className="flex flex-col gap-2.5" onSubmit={(e) => void submit(e)} data-testid="key-form">
      {fields.map((field) => (
        <div key={field} className="flex flex-col gap-1">
          <label htmlFor={`${id}-${field}`} className="text-app-ui-sm text-muted-foreground">
            {t(`remote.key.field.${kind === "create" ? `create-${field}` : field}`)}
          </label>
          <input
            id={`${id}-${field}`}
            type="password"
            className={inputClass}
            value={values[field]}
            disabled={busy}
            autoComplete={
              field === "password" || field === "current" ? "current-password" : "new-password"
            }
            onChange={(e) => setValues((now) => ({ ...now, [field]: e.target.value }))}
          />
        </div>
      ))}
      {error && (
        <p className="text-app-ui-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          size="sm"
          variant={kind === "reset" ? "destructive" : "default"}
          disabled={busy || fields.some((f) => !values[f])}
        >
          {t(`remote.key.submit.${kind}`)}
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={busy}>
            {t("remote.account.cancel")}
          </Button>
        )}
        {onForgot && (
          <button
            type="button"
            className="ml-auto cursor-pointer text-app-ui-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={onForgot}
          >
            {t("remote.key.forgot")}
          </button>
        )}
      </div>
    </form>
  );
}
