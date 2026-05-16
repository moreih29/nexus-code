/**
 * GitCommitInput owns the commit-message editing surface above status groups.
 */
import type { GitCommitOptions } from "../../../../../shared/git/types";
import type { GitActionButtonState } from "../../../../state/selectors/git-action-button";
import { GitCommitButton, type GitCommitMenuEnablement } from "./git-commit-button";

interface GitCommitInputProps {
  value: string;
  disabled?: boolean;
  busy?: boolean;
  hint?: string;
  action: GitActionButtonState;
  commitOptions: GitCommitOptions;
  menuEnablement: GitCommitMenuEnablement;
  onChange: (value: string) => void;
  onBlur: () => void;
  onPrimaryAction: () => void;
  onCommitStaged: () => void;
  onCommitAll: () => void;
  onAmend: () => void;
  onCommitAndPush: () => void;
  onCommitEmpty: () => void;
  onUndoLastCommit: () => void;
  onToggleCommitOption: <K extends keyof GitCommitOptions>(
    option: K,
    value: GitCommitOptions[K],
  ) => void;
  onPushOnly: () => void;
  onPullOnly: () => void;
}

/** Renders the commit message input with the task-6 split action control. */
export function GitCommitInput({
  value,
  disabled = false,
  busy = false,
  hint,
  action,
  commitOptions,
  menuEnablement,
  onChange,
  onBlur,
  onPrimaryAction,
  onCommitStaged,
  onCommitAll,
  onAmend,
  onCommitAndPush,
  onCommitEmpty,
  onUndoLastCommit,
  onToggleCommitOption,
  onPushOnly,
  onPullOnly,
}: GitCommitInputProps) {
  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.currentTarget.blur();
    }
  }

  return (
    <div className="flex flex-col gap-1 border-b border-mist-border px-2 pb-2 pt-1.5">
      <textarea
        value={value}
        rows={3}
        placeholder="Message"
        disabled={disabled}
        spellCheck={true}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        onKeyDown={handleKeyDown}
        className="min-h-[64px] resize-none rounded border border-mist-border bg-background px-2 py-1 text-app-body text-foreground outline-none placeholder:text-muted-foreground focus:border-mist-border-focus disabled:opacity-50"
        aria-label="Commit message"
      />
      <GitCommitButton
        action={action}
        busy={busy}
        commitOptions={commitOptions}
        enablement={menuEnablement}
        onPrimaryAction={onPrimaryAction}
        onCommitStaged={onCommitStaged}
        onCommitAll={onCommitAll}
        onAmend={onAmend}
        onCommitAndPush={onCommitAndPush}
        onCommitEmpty={onCommitEmpty}
        onUndoLastCommit={onUndoLastCommit}
        onToggleCommitOption={onToggleCommitOption}
        onPushOnly={onPushOnly}
        onPullOnly={onPullOnly}
      />
      {hint ? <p className="px-1 text-app-ui-sm text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
