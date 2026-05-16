/**
 * SshAuthPromptDialog presents remote SSH password and host-key prompts.
 *
 * The visual treatment intentionally follows the existing askpass modal: dark,
 * restrained chrome with the same background, border, and focus tokens.
 */
import { Dialog as RadixDialog } from "radix-ui";
import { useEffect, useState } from "react";
import type { SshAuthPrompt } from "../../../shared/ssh/auth-prompt";
import { copyText } from "../../utils/clipboard";
import { Button } from "../ui/button";

interface SshAuthPromptDialogProps {
  readonly prompt: SshAuthPrompt | null;
  readonly pendingMessage?: string | null;
  readonly busy?: boolean;
  readonly onCancel: () => void;
  readonly onSubmitPassword: (value: string) => void;
  readonly onTrustHostKey: () => void;
}

interface SshAuthPromptDialogContentProps {
  readonly prompt: SshAuthPrompt;
  readonly passwordValue: string;
  readonly pendingMessage?: string | null;
  readonly busy?: boolean;
  readonly onPasswordChange: (value: string) => void;
  readonly onCancel: () => void;
  readonly onCopyFingerprint: (fingerprint: string) => void;
  readonly onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}

/** Copies a host-key fingerprint through the renderer clipboard helper. */
export function copySshHostKeyFingerprint(fingerprint: string): void {
  copyText(fingerprint);
}

/** Returns the masked input type for password/passphrase prompts. */
export function sshAuthPromptInputType(field: Extract<SshAuthPrompt, { kind: "password" }>["field"]):
  | "password"
  | "text" {
  return field === "password" || field === "passphrase" ? "password" : "text";
}

/** Renders the dialog body separately so scenario tests can inspect markup. */
export function SshAuthPromptDialogContent({
  prompt,
  passwordValue,
  pendingMessage = null,
  busy = false,
  onPasswordChange,
  onCancel,
  onCopyFingerprint,
  onSubmit,
}: SshAuthPromptDialogContentProps): React.JSX.Element {
  const titleId = `ssh-auth-title-${prompt.promptId}`;
  const descriptionId = `ssh-auth-description-${prompt.promptId}`;
  const inputId = `ssh-auth-input-${prompt.promptId}`;
  const hostLine = formatHostLine(prompt);
  const isPasswordPrompt = prompt.kind === "password";
  const title = isPasswordPrompt
    ? prompt.field === "passphrase"
      ? "SSH passphrase required"
      : "SSH password required"
    : "Trust SSH host key";

  return (
    <>
      <h2 id={titleId} className="text-app-body-emphasis text-foreground">
        {title}
      </h2>
      <p id={descriptionId} className="mt-2 text-app-ui-sm text-muted-foreground">
        {hostLine}
      </p>
      {pendingMessage ? (
        <p className="mt-2 text-app-ui-xs text-muted-foreground">{pendingMessage}</p>
      ) : null}
      <form className="mt-4 flex flex-col gap-3" onSubmit={onSubmit}>
        {isPasswordPrompt ? (
          <>
            {prompt.retry ? (
              <p
                role="alert"
                className="rounded-[--radius-control] border border-destructive/40 bg-destructive/10 px-2 py-1 text-app-ui-xs text-destructive"
              >
                Authentication failed. Try again.
              </p>
            ) : null}
            <label htmlFor={inputId} className="text-app-ui-sm text-foreground">
              {prompt.field === "passphrase" ? "Passphrase" : "Password"}
            </label>
            <input
              id={inputId}
              type={sshAuthPromptInputType(prompt.field)}
              value={passwordValue}
              autoComplete="off"
              onChange={(event) => onPasswordChange(event.target.value)}
              className="w-full rounded-[--radius-control] border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
              disabled={busy}
            />
            <p className="text-app-ui-xs text-muted-foreground">{prompt.prompt}</p>
          </>
        ) : (
          <HostKeyPromptBody prompt={prompt} busy={busy} onCopyFingerprint={onCopyFingerprint} />
        )}
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={busy || (isPasswordPrompt && passwordValue.length === 0)}
          >
            {isPasswordPrompt ? "Continue" : "Trust"}
          </Button>
        </div>
      </form>
    </>
  );
}

/** Mounts SSH auth content in a Radix dialog with Escape cancel semantics. */
export function SshAuthPromptDialog({
  prompt,
  pendingMessage = null,
  busy = false,
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
    <RadixDialog.Root
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <RadixDialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[440px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-[--radius-container] border border-border bg-background p-5 text-foreground shadow-none outline-none"
          aria-labelledby={prompt ? `ssh-auth-title-${prompt.promptId}` : undefined}
          aria-describedby={prompt ? `ssh-auth-description-${prompt.promptId}` : undefined}
        >
          {prompt ? (
            <SshAuthPromptDialogContent
              prompt={prompt}
              passwordValue={passwordValue}
              pendingMessage={pendingMessage}
              busy={busy}
              onPasswordChange={setPasswordValue}
              onCancel={onCancel}
              onCopyFingerprint={copySshHostKeyFingerprint}
              onSubmit={handleSubmit}
            />
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** Renders host-key details and the first tabbable Copy action. */
function HostKeyPromptBody({
  prompt,
  busy,
  onCopyFingerprint,
}: {
  readonly prompt: Extract<SshAuthPrompt, { kind: "host-key" }>;
  readonly busy: boolean;
  readonly onCopyFingerprint: (fingerprint: string) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-app-ui-sm text-foreground">
        {prompt.message ?? "The server's host key is not yet trusted for this workspace."}
      </p>
      {prompt.keyType ? (
        <p className="text-app-ui-xs text-muted-foreground">Key type: {prompt.keyType}</p>
      ) : null}
      <div className="rounded-[--radius-control] border border-border bg-muted/30 p-3">
        <p className="text-app-ui-xs text-muted-foreground">Fingerprint</p>
        <p className="mt-1 break-all font-mono text-[14px] text-foreground">{prompt.fingerprint}</p>
      </div>
      <p className="text-app-ui-xs text-muted-foreground">
        If you don't recognize this fingerprint, do not trust the host.
      </p>
      <p className="text-app-ui-xs text-muted-foreground">Trust applies for this session only.</p>
      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => onCopyFingerprint(prompt.fingerprint)}
        >
          Copy
        </Button>
      </div>
    </div>
  );
}

/** Formats the remote identity line shown under the dialog title. */
function formatHostLine(prompt: SshAuthPrompt): string {
  const userPrefix = prompt.username ? `${prompt.username}@` : "";
  const portSuffix = prompt.port ? `:${prompt.port}` : "";
  return `${userPrefix}${prompt.host}${portSuffix}`;
}
