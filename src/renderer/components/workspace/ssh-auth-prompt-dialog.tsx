import { ArrowBigUp } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SshAuthPrompt } from "../../../shared/ssh/auth-prompt";
import { copyText } from "../../utils/clipboard";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogHeader } from "../ui/dialog-header";

interface SshAuthPromptDialogProps {
  readonly prompt: SshAuthPrompt | null;
  readonly pendingMessage?: string | null;
  readonly busy?: boolean;
  readonly isReattach?: boolean;
  readonly onCancel: () => void;
  readonly onSubmitPassword: (value: string) => void;
  readonly onTrustHostKey: () => void;
}

interface SshAuthPromptDialogContentProps {
  readonly prompt: SshAuthPrompt;
  readonly passwordValue: string;
  readonly pendingMessage?: string | null;
  readonly busy?: boolean;
  readonly isReattach?: boolean;
  readonly onPasswordChange: (value: string) => void;
  readonly onCancel: () => void;
  readonly onCopyFingerprint: (fingerprint: string) => void;
  readonly onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}

export function copySshHostKeyFingerprint(fingerprint: string): void {
  copyText(fingerprint);
}

export function sshAuthPromptInputType(
  field: Extract<SshAuthPrompt, { kind: "password" }>["field"],
): "password" | "text" {
  return field === "password" || field === "passphrase" ? "password" : "text";
}

export function SshAuthPromptDialogContent({
  prompt,
  passwordValue,
  pendingMessage = null,
  busy = false,
  isReattach = false,
  onPasswordChange,
  onCancel,
  onCopyFingerprint,
  onSubmit,
}: SshAuthPromptDialogContentProps): React.JSX.Element {
  const { t } = useTranslation();
  const inputId = `ssh-auth-input-${prompt.promptId}`;
  const hostLine = formatHostLine(prompt);
  const isPasswordPrompt = prompt.kind === "password";
  const title = isPasswordPrompt
    ? prompt.field === "passphrase"
      ? t("ssh.title_passphrase")
      : isReattach
        ? t("ssh.title_password_reattach", { host: prompt.host })
        : t("ssh.title_password")
    : t("ssh.title_host_key");

  const [capsLockOn, setCapsLockOn] = useState(false);

  function handleKeyUp(event: React.KeyboardEvent<HTMLInputElement>): void {
    setCapsLockOn(event.getModifierState("CapsLock"));
  }

  return (
    <>
      <DialogHeader title={title} description={hostLine} />
      {pendingMessage ? (
        <p className="mt-2 text-app-ui-sm text-muted-foreground">{pendingMessage}</p>
      ) : null}
      <form className="mt-4 flex flex-col gap-3" onSubmit={onSubmit}>
        {isPasswordPrompt ? (
          <>
            {prompt.retry ? (
              <p
                role="alert"
                className="rounded-(--radius-control) border border-[var(--state-error-border)] bg-[var(--state-error-bg)] px-2 py-1 text-app-ui-sm text-[var(--state-error-fg)]"
              >
                {t("ssh.auth_failed")}
              </p>
            ) : null}
            <label htmlFor={inputId} className="text-app-ui-sm text-foreground">
              {prompt.field === "passphrase" ? t("ssh.label_passphrase") : t("ssh.label_password")}
            </label>
            <input
              id={inputId}
              type={sshAuthPromptInputType(prompt.field)}
              value={passwordValue}
              autoComplete="off"
              onChange={(event) => onPasswordChange(event.target.value)}
              onKeyUp={handleKeyUp}
              className="w-full rounded-(--radius-control) border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
              disabled={busy}
            />
            {capsLockOn ? (
              <p
                role="status"
                aria-live="polite"
                className="flex items-center gap-1.5 text-app-ui-sm text-[var(--state-warning-fg)]"
              >
                <ArrowBigUp className="size-4 shrink-0" aria-hidden="true" />
                {t("ssh.caps_lock")}
              </p>
            ) : null}
            <p className="text-app-ui-sm text-muted-foreground">{prompt.prompt}</p>
          </>
        ) : (
          <HostKeyPromptBody prompt={prompt} busy={busy} onCopyFingerprint={onCopyFingerprint} />
        )}
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            {t("action.cancel")}
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={busy || (isPasswordPrompt && passwordValue.length === 0)}
          >
            {isPasswordPrompt ? t("ssh.continue") : t("ssh.trust")}
          </Button>
        </div>
      </form>
    </>
  );
}

export function SshAuthPromptDialog({
  prompt,
  pendingMessage = null,
  busy = false,
  isReattach = false,
  onCancel,
  onSubmitPassword,
  onTrustHostKey,
}: SshAuthPromptDialogProps): React.JSX.Element {
  const [passwordValue, setPasswordValue] = useState("");

  useEffect(() => {
    if (prompt) setPasswordValue("");
  }, [prompt]);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (busy || !prompt) return;
    if (prompt.kind === "password") {
      if (passwordValue.length === 0) return;
      onSubmitPassword(passwordValue);
      return;
    }
    onTrustHostKey();
  }

  return (
    <Dialog
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      size="md"
    >
      {prompt ? (
        <SshAuthPromptDialogContent
          prompt={prompt}
          passwordValue={passwordValue}
          pendingMessage={pendingMessage}
          busy={busy}
          isReattach={isReattach}
          onPasswordChange={setPasswordValue}
          onCancel={onCancel}
          onCopyFingerprint={copySshHostKeyFingerprint}
          onSubmit={handleSubmit}
        />
      ) : null}
    </Dialog>
  );
}

function HostKeyPromptBody({
  prompt,
  busy,
  onCopyFingerprint,
}: {
  readonly prompt: Extract<SshAuthPrompt, { kind: "host-key" }>;
  readonly busy: boolean;
  readonly onCopyFingerprint: (fingerprint: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-app-ui-sm text-foreground">
        {prompt.message ?? t("ssh.host_key_default", { host: prompt.host })}
      </p>
      {prompt.keyType ? (
        <p className="text-app-ui-sm text-muted-foreground">
          {t("ssh.key_type", { type: prompt.keyType })}
        </p>
      ) : null}
      <div className="rounded-(--radius-control) border border-border bg-muted/30 p-3">
        <p className="text-app-ui-sm text-muted-foreground">{t("ssh.fingerprint")}</p>
        <p className="mt-1 break-all font-mono text-[14px] text-foreground">{prompt.fingerprint}</p>
      </div>
      <p className="text-app-ui-sm text-muted-foreground">{t("ssh.fingerprint_warning")}</p>
      <p className="text-app-ui-sm text-muted-foreground">{t("ssh.trust_saved")}</p>
      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => onCopyFingerprint(prompt.fingerprint)}
        >
          {t("action.copy")}
        </Button>
      </div>
    </div>
  );
}

function formatHostLine(prompt: SshAuthPrompt): string {
  const userPrefix = prompt.username ? `${prompt.username}@` : "";
  const portSuffix = prompt.port ? `:${prompt.port}` : "";
  return `${userPrefix}${prompt.host}${portSuffix}`;
}
