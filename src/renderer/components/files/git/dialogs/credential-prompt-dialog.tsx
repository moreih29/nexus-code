/**
 * CredentialPromptDialog renders Git askpass prompts as one reusable modal.
 *
 * The parent replaces `prompt` as Git asks for username then password, so the
 * same dialog instance re-renders rather than stacking multiple modals.
 */
import { Dialog as RadixDialog } from "radix-ui";
import { useEffect, useState } from "react";
import type { AskpassPrompt } from "../../../../../shared/git/types";
import { Button } from "../../../ui/button";

interface CredentialPromptDialogProps {
  prompt: AskpassPrompt | null;
  busy?: boolean;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}

interface CredentialPromptDialogContentProps {
  prompt: AskpassPrompt;
  value: string;
  busy?: boolean;
  onValueChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}

/**
 * Returns the input type that keeps passwords/passphrases masked.
 */
export function credentialPromptInputType(field: AskpassPrompt["field"]): "text" | "password" {
  return field === "password" || field === "passphrase" ? "password" : "text";
}

/**
 * Presents the form body separately from the Radix portal for static renderer
 * tests and for keeping modal chrome focused in the wrapper component.
 */
export function CredentialPromptDialogContent({
  prompt,
  value,
  busy = false,
  onValueChange,
  onCancel,
  onSubmit,
}: CredentialPromptDialogContentProps): React.JSX.Element {
  const inputId = `git-credential-${prompt.promptId}`;
  const title = prompt.field === "passphrase" ? "SSH passphrase required" : "Git credentials";
  const label =
    prompt.field === "username"
      ? "Username"
      : prompt.field === "passphrase"
        ? "Passphrase"
        : prompt.field === "password"
          ? "Password"
          : "Response";

  return (
    <>
      <h2 className="text-app-body-emphasis text-foreground">{title}</h2>
      <p className="mt-2 text-app-ui-sm text-muted-foreground">{prompt.service ?? prompt.prompt}</p>
      <form className="mt-4 flex flex-col gap-2" onSubmit={onSubmit}>
        <label htmlFor={inputId} className="text-app-ui-sm text-foreground">
          {label}
        </label>
        <input
          id={inputId}
          type={credentialPromptInputType(prompt.field)}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          className="w-full rounded-(--radius-control) border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
          disabled={busy}
        />
        <p className="text-app-ui-sm text-muted-foreground">{prompt.prompt}</p>
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy || value.length === 0}>
            Continue
          </Button>
        </div>
      </form>
    </>
  );
}

/**
 * Mounts the credential form in a Radix dialog. Escape and outside-click
 * dismissal both call `onCancel` through Radix's open-state callback.
 */
export function CredentialPromptDialog({
  prompt,
  busy = false,
  onCancel,
  onSubmit,
}: CredentialPromptDialogProps): React.JSX.Element {
  const [value, setValue] = useState("");

  useEffect(() => {
    if (prompt) setValue("");
  }, [prompt]);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (busy || value.length === 0) return;
    onSubmit(value);
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
          className="fixed left-1/2 top-1/2 z-50 w-[420px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-(--radius-island) border border-border bg-background p-5 text-foreground shadow-none outline-none"
          aria-label="Git credentials"
        >
          {prompt ? (
            <CredentialPromptDialogContent
              prompt={prompt}
              value={value}
              busy={busy}
              onValueChange={setValue}
              onCancel={onCancel}
              onSubmit={handleSubmit}
            />
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
