/**
 * GitHeader renders the Source Control title and top-level action buttons.
 */
import { RefreshCw } from "lucide-react";
import { Button } from "../../ui/button";
import { GitMoreMenu } from "./GitMoreMenu";

interface GitHeaderProps {
  disabled?: boolean;
  refreshing?: boolean;
  canInit?: boolean;
  hasChanges?: boolean;
  onRefresh: () => void;
  onInit: () => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onStash: () => void;
  onStashPop: () => void;
  onCheckout: () => void;
  onCreateBranch: () => void;
  onDiscardAll: () => void;
}

export function GitHeader({
  disabled = false,
  refreshing = false,
  canInit = false,
  hasChanges = false,
  onRefresh,
  onInit,
  onFetch,
  onPull,
  onPush,
  onStash,
  onStashPop,
  onCheckout,
  onCreateBranch,
  onDiscardAll,
}: GitHeaderProps) {
  return (
    <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-mist-border px-2">
      <span className="min-w-0 truncate text-small-label uppercase text-muted-foreground">
        Source Control
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7"
          aria-label="Refresh source control"
          title="Refresh source control"
          disabled={disabled || refreshing}
          onClick={onRefresh}
        >
          <RefreshCw className={refreshing ? "size-4 animate-spin" : "size-4"} aria-hidden="true" />
        </Button>
        <GitMoreMenu
          disabled={disabled}
          canInit={canInit}
          hasChanges={hasChanges}
          onRefresh={onRefresh}
          onInit={onInit}
          onFetch={onFetch}
          onPull={onPull}
          onPush={onPush}
          onStash={onStash}
          onStashPop={onStashPop}
          onCheckout={onCheckout}
          onCreateBranch={onCreateBranch}
          onDiscardAll={onDiscardAll}
        />
      </div>
    </div>
  );
}
