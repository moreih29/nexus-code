// src/renderer/components/settings/panels/remote-password-dialog.tsx
//
// Asks for the account password before what only the account's owner may
// do (account keys v2): removing another device, which rotates the account
// key, and deleting the account. The dialog stays open on a wrong password
// and says why.

import { Dialog as RadixDialog } from "radix-ui";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/ui/dialog";
import { DialogHeader } from "@/components/ui/dialog-header";
import { Button } from "../../ui/button";

export interface PasswordRequest {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly destructive?: boolean;
  /** Runs with the password: null once done, else what to say in the dialog. */
  run(password: string): Promise<string | null>;
  /** Another way to go on without the password, beside Cancel. */
  readonly withoutPassword?: {
    readonly label: string;
    run(): Promise<string | null>;
  };
}

export function PasswordDialog({
  request,
  onClose,
}: {
  request: PasswordRequest | null;
  onClose(): void;
}) {
  const { t } = useTranslation("settings");
  const id = useId();
  const input = useRef<HTMLInputElement | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPassword("");
    setError(null);
    if (request) input.current?.focus();
  }, [request]);

  const finish = (failure: string | null) => {
    setBusy(false);
    if (failure === null) {
      setPassword("");
      onClose();
    } else setError(failure);
  };

  const skip = async () => {
    const other = request?.withoutPassword;
    if (!other || busy) return;
    setBusy(true);
    setError(null);
    finish(await other.run());
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!request || busy || !password) return;
    setBusy(true);
    setError(null);
    finish(await request.run(password));
  };

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      size="sm"
    >
      <DialogHeader title={request?.title ?? ""} description={request?.description} />
      <form className="mt-4 flex flex-col gap-2" onSubmit={(e) => void submit(e)}>
        <label htmlFor={id} className="text-app-ui-sm text-foreground">
          {t("remote.key.field.password")}
        </label>
        <input
          ref={input}
          id={id}
          type="password"
          autoComplete="current-password"
          value={password}
          disabled={busy}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-(--radius-control) border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        {error && (
          <p className="text-app-ui-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="mt-3 flex justify-end gap-2">
          {request?.withoutPassword && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mr-auto"
              disabled={busy}
              onClick={() => void skip()}
            >
              {request.withoutPassword.label}
            </Button>
          )}
          <RadixDialog.Close asChild>
            <Button type="button" variant="ghost" size="sm" disabled={busy}>
              {t("remote.account.cancel")}
            </Button>
          </RadixDialog.Close>
          <Button
            type="submit"
            size="sm"
            variant={request?.destructive ? "destructive" : "default"}
            disabled={busy || !password}
          >
            {request?.confirmLabel ?? ""}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
