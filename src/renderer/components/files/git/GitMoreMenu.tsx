/**
 * GitMoreMenu — overflow menu for Source Control operations.
 *
 * Per-action enablement is driven by `RepoCapabilities` rather than a
 * single `disabled` flag so the user never reaches an action that would
 * fail with a raw stderr message:
 *
 *   - Stash      → requires hasHEAD (no commits → "no initial commit yet")
 *   - Stash Pop  → requires stashCount > 0 (else "No stash entries found")
 *   - Fetch/Pull → requires at least one configured remote
 *   - Push       → requires at least one configured remote (publishing
 *                  without an upstream is handled by a parent dialog, not
 *                  by hiding the menu item)
 *
 * Tooltips spell out the reason a disabled item is disabled so the user
 * knows what to do next without trial and error.
 */
import { ChevronRight, MoreHorizontal } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type {
  BranchInfo,
  GitAutofetchIntervalMin,
  RepoCapabilities,
} from "../../../../shared/types/git";
import { Button } from "../../ui/button";
import { useDismissOnOutsideClick } from "../../ui/use-dismiss-on-outside-click";

export type GitRemotesMenuSpec =
  | { kind: "remote"; remote: string; label: string }
  | { kind: "empty"; label: string }
  | { kind: "action"; id: "add-remote" | "remove-remote"; label: string; disabled?: boolean };

export interface GitAutofetchMenuOption {
  readonly intervalMin: GitAutofetchIntervalMin;
  readonly label: string;
  readonly selected: boolean;
}

interface GitMoreMenuProps {
  disabled?: boolean;
  canInit?: boolean;
  hasChanges?: boolean;
  /** Repository-level capability flags. Falsy when the repo is detecting / non-repo. */
  capabilities?: RepoCapabilities;
  onRefresh: () => void;
  onInit: () => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onStash: () => void;
  onStashPop: () => void;
  onOpenStashes: () => void;
  onOpenTags: () => void;
  onSwitchBranch: () => void;
  onMergeBranch: () => void;
  onRebaseBranch: () => void;
  onCherryPick: () => void;
  onAddRemote: () => void;
  onRemoveRemote: (remote: string) => void;
  onDiscardAll: () => void;
  autofetchIntervalMin: GitAutofetchIntervalMin;
  lastFetchedAt: number | null;
  onSetAutofetchInterval: (intervalMin: GitAutofetchIntervalMin) => void;
}

/**
 * Builds the Remotes submenu model used by the menu renderer and tests.
 */
export function buildGitRemotesMenuModel(remotes: readonly string[]): GitRemotesMenuSpec[] {
  const currentRemotes: GitRemotesMenuSpec[] =
    remotes.length > 0
      ? remotes.map((remote) => ({ kind: "remote", remote, label: remote }))
      : [{ kind: "empty", label: "No remotes configured" }];
  return [
    ...currentRemotes,
    { kind: "action", id: "add-remote", label: "Add remote…" },
    {
      kind: "action",
      id: "remove-remote",
      label: "Remove remote…",
      disabled: remotes.length === 0,
    },
  ];
}

/**
 * Returns the exact warning shown before removing the remote that backs the
 * current branch upstream, or null when removal does not affect tracking.
 */
export function buildRemoteUpstreamWarning(
  branch: BranchInfo | null | undefined,
  remote: string,
): string | null {
  if (!branch?.upstream?.startsWith(`${remote}/`)) return null;
  return `${branch.current} tracks ${remote}/... Removing detaches upstream tracking.`;
}

/** Builds the fixed Autofetch submenu options, marking the selected interval. */
export function buildAutofetchMenuModel(
  selected: GitAutofetchIntervalMin,
): GitAutofetchMenuOption[] {
  return [
    { intervalMin: 0, label: "Off", selected: selected === 0 },
    { intervalMin: 1, label: "Every 1 min", selected: selected === 1 },
    { intervalMin: 3, label: "Every 3 min (default)", selected: selected === 3 },
    { intervalMin: 5, label: "Every 5 min", selected: selected === 5 },
    { intervalMin: 15, label: "Every 15 min", selected: selected === 15 },
  ];
}

/** Formats the menu caption from FETCH_HEAD mtime. */
export function formatLastFetchedCaption(lastFetchedAt: number | null, now = Date.now()): string {
  if (lastFetchedAt === null) return "Last fetched never";
  const ageMs = Math.max(0, now - lastFetchedAt);
  const ageMin = Math.floor(ageMs / 60_000);
  if (ageMin < 1) return "Last fetched just now";
  if (ageMin < 60) return `Last fetched ${ageMin}m ago`;
  const ageHours = Math.floor(ageMin / 60);
  if (ageHours < 24) return `Last fetched ${ageHours}h ago`;
  return `Last fetched ${Math.floor(ageHours / 24)}d ago`;
}

export function GitMoreMenu({
  disabled = false,
  canInit = false,
  hasChanges = false,
  capabilities,
  onRefresh,
  onInit,
  onFetch,
  onPull,
  onPush,
  onStash,
  onStashPop,
  onOpenStashes,
  onOpenTags,
  onSwitchBranch,
  onMergeBranch,
  onRebaseBranch,
  onCherryPick,
  onAddRemote,
  onRemoveRemote,
  onDiscardAll,
  autofetchIntervalMin,
  lastFetchedAt,
  onSetAutofetchInterval,
}: GitMoreMenuProps) {
  const [open, setOpen] = useState(false);
  const [remotesOpen, setRemotesOpen] = useState(false);
  const [removeRemoteOpen, setRemoveRemoteOpen] = useState(false);
  const [autofetchOpen, setAutofetchOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    setRemotesOpen(false);
    setRemoveRemoteOpen(false);
    setAutofetchOpen(false);
  }, []);
  useDismissOnOutsideClick(wrapperRef, open, close);

  function run(action: () => void): void {
    close();
    action();
  }

  const repoBusy = disabled || canInit;
  const remotes = capabilities?.remotes ?? [];
  const hasRemote = (capabilities?.remotes.length ?? 0) > 0;
  const hasHead = capabilities?.hasHEAD ?? false;
  const stashCount = capabilities?.stashCount ?? 0;

  // Disable reasons documented as tooltips so screen readers and hover
  // surfaces explain the gating; an enabled action falls back to its label.
  const fetchReason = hasRemote ? null : "Add a remote first.";
  const pullReason = hasRemote ? null : "Add a remote first.";
  const pushReason = hasRemote ? null : "Add a remote first.";
  const stashReason = hasHead ? null : "Make an initial commit first.";
  const tagReason = hasHead ? null : "Make an initial commit first.";
  const workflowReason = hasHead ? null : "Make an initial commit first.";
  const stashPopReason =
    stashCount === 0 ? "Stash is empty." : !hasHead ? "Make an initial commit first." : null;

  return (
    <div className="relative" ref={wrapperRef}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-7"
        aria-label="More source control actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            close();
          } else {
            setOpen(true);
          }
        }}
      >
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-8 z-40 min-w-[188px] rounded border border-mist-border bg-popover p-1 text-popover-foreground shadow-sm"
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
        >
          <MenuButton label="Refresh" onClick={() => run(onRefresh)} disabled={disabled} />
          {canInit ? (
            <MenuButton
              label="Initialize Repository"
              onClick={() => run(onInit)}
              disabled={disabled}
            />
          ) : null}
          <MenuSeparator />
          <MenuButton
            label="Fetch"
            onClick={() => run(onFetch)}
            disabled={repoBusy || !hasRemote}
            title={fetchReason ?? undefined}
          />
          <MenuButton
            label="Pull"
            onClick={() => run(onPull)}
            disabled={repoBusy || !hasRemote}
            title={pullReason ?? undefined}
          />
          <MenuButton
            label="Push"
            onClick={() => run(onPush)}
            disabled={repoBusy || !hasRemote}
            title={pushReason ?? undefined}
          />
          <AutofetchSubmenu
            open={autofetchOpen}
            selected={autofetchIntervalMin}
            lastFetchedAt={lastFetchedAt}
            disabled={disabled}
            onOpenChange={setAutofetchOpen}
            onSelect={(intervalMin) => run(() => onSetAutofetchInterval(intervalMin))}
          />
          <MenuSeparator />
          <MenuButton
            label="Checkout to…"
            onClick={() => run(onSwitchBranch)}
            disabled={repoBusy}
          />
          <MenuButton
            label="Merge Branch…"
            onClick={() => run(onMergeBranch)}
            disabled={repoBusy || !hasHead}
            title={workflowReason ?? undefined}
          />
          <MenuButton
            label="Rebase Current Branch…"
            onClick={() => run(onRebaseBranch)}
            disabled={repoBusy || !hasHead}
            title={workflowReason ?? undefined}
          />
          <MenuButton
            label="Cherry-pick Commit…"
            onClick={() => run(onCherryPick)}
            disabled={repoBusy || !hasHead}
            title={workflowReason ?? undefined}
          />
          <RemotesSubmenu
            open={remotesOpen}
            removeOpen={removeRemoteOpen}
            remotes={remotes}
            disabled={repoBusy}
            onOpenChange={setRemotesOpen}
            onRemoveOpenChange={setRemoveRemoteOpen}
            onAddRemote={() => run(onAddRemote)}
            onRemoveRemote={(remote) => run(() => onRemoveRemote(remote))}
          />
          <MenuButton
            label="Tags…"
            onClick={() => run(onOpenTags)}
            disabled={repoBusy || !hasHead}
            title={tagReason ?? undefined}
          />
          <MenuSeparator />
          <MenuButton
            label="Stash"
            onClick={() => run(onStash)}
            disabled={repoBusy || !hasHead}
            title={stashReason ?? undefined}
          />
          <MenuButton
            label="Stash Pop"
            onClick={() => run(onStashPop)}
            disabled={repoBusy || stashCount === 0 || !hasHead}
            title={stashPopReason ?? undefined}
          />
          <MenuButton
            label="Stashes…"
            onClick={() => run(onOpenStashes)}
            disabled={repoBusy || !hasHead}
            title={stashReason ?? undefined}
          />
          <MenuSeparator />
          <MenuButton
            label="Discard All Changes"
            onClick={() => run(onDiscardAll)}
            disabled={repoBusy || !hasChanges}
            destructive
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Renders the Remotes flyout with read-only current remotes plus add/remove
 * actions. Removal has its own nested picker so the user explicitly selects
 * which remote to delete before the confirmation dialog appears.
 */
function RemotesSubmenu({
  open,
  removeOpen,
  remotes,
  disabled,
  onOpenChange,
  onRemoveOpenChange,
  onAddRemote,
  onRemoveRemote,
}: {
  open: boolean;
  removeOpen: boolean;
  remotes: readonly string[];
  disabled?: boolean;
  onOpenChange: (open: boolean) => void;
  onRemoveOpenChange: (open: boolean) => void;
  onAddRemote: () => void;
  onRemoveRemote: (remote: string) => void;
}) {
  const model = buildGitRemotesMenuModel(remotes);
  const currentRemotes = model.filter((item) => item.kind === "remote" || item.kind === "empty");

  return (
    <div className="relative">
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        className="flex w-full items-center justify-between gap-3 rounded-[3px] px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-frosted-veil-strong focus-visible:bg-frosted-veil-strong focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        onClick={() => onOpenChange(!open)}
      >
        <span>Remotes</span>
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute left-full top-0 z-50 min-w-[188px] rounded border border-mist-border bg-popover p-1 text-popover-foreground shadow-sm"
        >
          {currentRemotes.map((item) =>
            item.kind === "remote" ? (
              <RemoteLabel key={item.remote} label={item.label} />
            ) : (
              <RemoteLabel key="empty" label={item.label} muted />
            ),
          )}
          <MenuSeparator />
          <MenuButton label="Add remote…" onClick={onAddRemote} disabled={disabled} />
          <RemoveRemoteSubmenu
            open={removeOpen}
            remotes={remotes}
            disabled={disabled || remotes.length === 0}
            onOpenChange={onRemoveOpenChange}
            onRemoveRemote={onRemoveRemote}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Renders the Autofetch cadence flyout plus last-fetched caption. */
function AutofetchSubmenu({
  open,
  selected,
  lastFetchedAt,
  disabled,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  selected: GitAutofetchIntervalMin;
  lastFetchedAt: number | null;
  disabled?: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (intervalMin: GitAutofetchIntervalMin) => void;
}) {
  const model = buildAutofetchMenuModel(selected);
  return (
    <div className="relative">
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        className="flex w-full items-center justify-between gap-3 rounded-[3px] px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-frosted-veil-strong focus-visible:bg-frosted-veil-strong focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        onClick={() => onOpenChange(!open)}
      >
        <span>Autofetch</span>
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute left-full top-0 z-50 min-w-[188px] rounded border border-mist-border bg-popover p-1 text-popover-foreground shadow-sm"
        >
          {model.map((item) => (
            <MenuButton
              key={item.intervalMin}
              label={`${item.selected ? "✓ " : ""}${item.label}`}
              onClick={() => onSelect(item.intervalMin)}
            />
          ))}
          <MenuSeparator />
          <div className="px-2 py-1 text-app-ui-sm text-muted-foreground">
            {formatLastFetchedCaption(lastFetchedAt)}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Renders a non-clickable current-remote row in the Remotes submenu.
 */
function RemoteLabel({ label, muted = false }: { label: string; muted?: boolean }) {
  return (
    <div
      className={
        muted
          ? "flex w-full rounded-[3px] px-2 py-1 text-left text-app-ui-sm text-muted-foreground"
          : "flex w-full rounded-[3px] px-2 py-1 text-left text-app-ui-sm text-foreground"
      }
    >
      {label}
    </div>
  );
}

/**
 * Renders the remove-remote picker nested under the Remotes flyout.
 */
function RemoveRemoteSubmenu({
  open,
  remotes,
  disabled,
  onOpenChange,
  onRemoveRemote,
}: {
  open: boolean;
  remotes: readonly string[];
  disabled?: boolean;
  onOpenChange: (open: boolean) => void;
  onRemoveRemote: (remote: string) => void;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={remotes.length === 0 ? "No remotes configured." : undefined}
        className="flex w-full items-center justify-between gap-3 rounded-[3px] px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-frosted-veil-strong focus-visible:bg-frosted-veil-strong focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        onClick={() => onOpenChange(!open)}
      >
        <span>Remove remote…</span>
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute left-full top-0 z-50 min-w-[152px] rounded border border-mist-border bg-popover p-1 text-popover-foreground shadow-sm"
        >
          {remotes.map((remote) => (
            <MenuButton key={remote} label={remote} onClick={() => onRemoveRemote(remote)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MenuButton({
  label,
  disabled,
  destructive,
  title,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      className={
        destructive
          ? "flex w-full rounded-[3px] px-2 py-1 text-left text-app-ui-sm git-destructive-text hover:bg-frosted-veil-strong focus-visible:bg-frosted-veil-strong focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          : "flex w-full rounded-[3px] px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-frosted-veil-strong focus-visible:bg-frosted-veil-strong focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
      }
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function MenuSeparator() {
  return <hr className="my-1 h-px border-0 bg-mist-border" />;
}
