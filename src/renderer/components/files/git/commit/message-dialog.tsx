/**
 * CommitMessageDialog renders Git's editor hook as a modal textarea.
 *
 * The helper manager writes the saved content back to Git's temporary message
 * file; cancel maps to a non-zero editor exit so Git aborts the commit.
 */
import { Dialog as RadixDialog } from "radix-ui";
import { useEffect, useState } from "react";
import type { GitEditorPrompt } from "../../../../../shared/git/types";
import { Button } from "../../../ui/button";

interface CommitMessageDialogProps {
  prompt: GitEditorPrompt | null;
  busy?: boolean;
  onCancel: () => void;
  onSave: (content: string) => void;
}

interface CommitMessageDialogContentProps {
  prompt: GitEditorPrompt;
  content: string;
  busy?: boolean;
  onContentChange: (content: string) => void;
  onCancel: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}

/**
 * Checks whether a commit message has non-comment text Git can commit.
 */
export function hasCommitMessageBody(content: string): boolean {
  return content
    .split(/\r?\n/)
    .some((line) => !line.trimStart().startsWith("#") && line.trim().length > 0);
}

/**
 * Renders the editor form body without creating a portal, keeping static tests
 * focused on the commit-message controls.
 */
export function CommitMessageDialogContent({
  prompt,
  content,
  busy = false,
  onContentChange,
  onCancel,
  onSubmit,
}: CommitMessageDialogContentProps): React.JSX.Element {
  const textareaId = `git-editor-${prompt.promptId}`;
  const canSave = !busy && hasCommitMessageBody(content);

  return (
    <>
      <h2 className="text-app-body-emphasis text-foreground">Commit message</h2>
      <p className="mt-2 text-app-ui-sm text-muted-foreground">
        Edit the message Git will use for this commit. Lines starting with # are preserved for Git
        to strip.
      </p>
      <form className="mt-4 flex flex-col gap-2" onSubmit={onSubmit}>
        <label htmlFor={textareaId} className="text-app-ui-sm text-foreground">
          Message
        </label>
        <textarea
          id={textareaId}
          value={content}
          onChange={(event) => onContentChange(event.target.value)}
          className="min-h-52 w-full resize-y rounded-[--radius-control] border border-border bg-background px-2 py-1 font-mono text-app-code text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
          disabled={busy}
        />
        <p className="text-app-ui-xs text-muted-foreground">{prompt.filePath}</p>
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!canSave}>
            Save
          </Button>
        </div>
      </form>
    </>
  );
}

/**
 * Mounts the commit-message form in a Radix dialog. Escape and outside-click
 * dismissal both call `onCancel` through Radix's open-state callback.
 */
export function CommitMessageDialog({
  prompt,
  busy = false,
  onCancel,
  onSave,
}: CommitMessageDialogProps): React.JSX.Element {
  const [content, setContent] = useState("");

  useEffect(() => {
    if (prompt) setContent(prompt.initialContent);
  }, [prompt]);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (busy || !hasCommitMessageBody(content)) return;
    onSave(content);
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
          className="fixed left-1/2 top-1/2 z-50 w-[560px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-[--radius-container] border border-border bg-background p-5 text-foreground shadow-none outline-none"
          aria-label="Commit message"
        >
          {prompt ? (
            <CommitMessageDialogContent
              prompt={prompt}
              content={content}
              busy={busy}
              onContentChange={setContent}
              onCancel={onCancel}
              onSubmit={handleSubmit}
            />
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
