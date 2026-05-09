/**
 * GitCommitButton renders the primary Commit action and its lightweight split menu.
 */
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Button } from "../../ui/button";

interface GitCommitButtonProps {
  disabled?: boolean;
  busy?: boolean;
  onCommit: () => void;
  onAmend: () => void;
  onCommitAndPush: () => void;
  onCommitStaged: () => void;
}

export function GitCommitButton({
  disabled = false,
  busy = false,
  onCommit,
  onAmend,
  onCommitAndPush,
  onCommitStaged,
}: GitCommitButtonProps) {
  const [open, setOpen] = useState(false);

  function run(action: () => void): void {
    setOpen(false);
    action();
  }

  return (
    <div className="relative flex w-full">
      <Button
        type="button"
        variant="default"
        size="sm"
        className="h-7 min-w-0 flex-1 rounded-r-none text-app-ui-sm"
        disabled={disabled || busy}
        onClick={onCommit}
      >
        {busy ? "Committing…" : "Commit"}
      </Button>
      <Button
        type="button"
        variant="default"
        size="icon-sm"
        className="h-7 w-8 rounded-l-none border-l border-mist-border/50"
        aria-label="Show commit options"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || busy}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-8 z-40 min-w-[176px] rounded border border-mist-border bg-popover p-1 text-popover-foreground shadow-sm"
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
        >
          <MenuButton label="Commit Staged" onClick={() => run(onCommitStaged)} />
          <MenuButton label="Amend Last Commit" onClick={() => run(onAmend)} />
          <MenuButton label="Commit & Push" onClick={() => run(onCommitAndPush)} />
        </div>
      ) : null}
    </div>
  );
}

function MenuButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      className="flex w-full rounded-[3px] px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-frosted-veil-strong focus-visible:bg-frosted-veil-strong focus-visible:outline-none"
      onClick={onClick}
    >
      {label}
    </button>
  );
}
