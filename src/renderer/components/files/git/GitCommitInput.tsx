/**
 * GitCommitInput owns the commit-message editing surface above status groups.
 */
import { GitCommitButton } from "./GitCommitButton";

interface GitCommitInputProps {
  value: string;
  disabled?: boolean;
  commitDisabled?: boolean;
  busy?: boolean;
  hint?: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  onCommit: () => void;
  onAmend: () => void;
  onCommitAndPush: () => void;
  onCommitStaged: () => void;
}

export function GitCommitInput({
  value,
  disabled = false,
  commitDisabled = false,
  busy = false,
  hint,
  onChange,
  onBlur,
  onCommit,
  onAmend,
  onCommitAndPush,
  onCommitStaged,
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
        disabled={commitDisabled}
        busy={busy}
        onCommit={onCommit}
        onAmend={onAmend}
        onCommitAndPush={onCommitAndPush}
        onCommitStaged={onCommitStaged}
      />
      {hint ? <p className="px-1 text-app-ui-sm text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
