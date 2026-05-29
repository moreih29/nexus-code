/**
 * GitBranchPopover owns the BranchChip trigger, single sync CTA, and branch
 * context menu. Branch-management pickers remain owned by GitPanel; this
 * surface focuses on fetch/pull/push/publish decisions.
 */
import { ChevronRight, Loader2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import i18next from "i18next";
import { useTranslation } from "react-i18next";
import type {
  BranchInfo,
  GitAutofetchIntervalMin,
  RepoCapabilities,
} from "../../../../../shared/git/types";
import { copyText } from "../../../../utils/clipboard";
import { Button } from "../../../ui/button";
import { useDismissOnOutsideClick } from "../../../ui/use-dismiss-on-outside-click";
import { buildAutofetchMenuModel } from "../utils/more-menu-model";
import { BranchChip } from "./chip";

interface GitBranchPopoverProps {
  workspaceId: string;
  branch: BranchInfo | null;
  repoPath?: string;
  disabled?: boolean;
  capabilities?: RepoCapabilities;
  autofetchIntervalMin: GitAutofetchIntervalMin;
  autofetchFetching?: boolean;
  autofetchFailed?: boolean;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onPublish: () => void;
  onSync: () => void;
  onSetAutofetchInterval: (intervalMin: GitAutofetchIntervalMin) => void;
}

export type GitBranchPrimaryActionId = "fetch" | "pull" | "push" | "publish" | "sync";

export interface GitBranchPrimaryAction {
  readonly id: GitBranchPrimaryActionId;
  readonly label: string;
  readonly disabled?: boolean;
  readonly reason?: string;
}

export interface GitBranchContextMenuItem {
  readonly id: "fetch" | "pull" | "push" | "publish" | "copy-upstream" | "autofetch";
  readonly label: string;
  readonly disabled?: boolean;
  readonly reason?: string;
}

interface ContextPoint {
  readonly x: number;
  readonly y: number;
}

export interface GitBranchPopoverContentProps {
  readonly branch: BranchInfo | null;
  readonly repoPath?: string;
  readonly disabled?: boolean;
  readonly primaryAction: GitBranchPrimaryAction;
  readonly autofetchFetching?: boolean;
  readonly autofetchFailed?: boolean;
  readonly onPrimary: () => void;
  readonly onRetryFetch: () => void;
}

/** Chooses the single CTA shown in the branch popover body. */
export function getGitBranchPrimaryAction(input: {
  branch: BranchInfo | null;
  capabilities?: RepoCapabilities;
  failed?: boolean;
}): GitBranchPrimaryAction {
  const t = i18next.t.bind(i18next);
  const branch = input.branch;
  const hasRemote = (input.capabilities?.remotes.length ?? 0) > 0;
  const hasHead = input.capabilities?.hasHEAD ?? false;

  if (input.failed) return { id: "fetch", label: t("files:git.branchPopover.fetchNow") };
  if (!branch) return { id: "fetch", label: t("files:git.branchPopover.fetchNow"), disabled: true, reason: t("files:git.branchPopover.noBranch") };
  if (!branch.upstream) {
    return {
      id: "publish",
      label: t("files:git.branchPopover.publishBranch"),
      disabled: !hasRemote || !hasHead,
      reason: !hasHead ? t("files:git.branchPopover.requiresCommit") : t("files:git.branchPopover.addRemoteFirst"),
    };
  }
  if (branch.ahead > 0 && branch.behind > 0) return { id: "sync", label: t("files:git.branchPopover.sync") };
  if (branch.behind > 0) return { id: "pull", label: t("files:git.branchPopover.pull") };
  if (branch.ahead > 0) return { id: "push", label: t("files:git.branchPopover.push") };
  return { id: "fetch", label: t("files:git.branchPopover.fetchNow") };
}

/** Builds the right-click BranchChip context menu item list. */
export function buildGitBranchContextMenuModel(input: {
  branch: BranchInfo | null;
  capabilities?: RepoCapabilities;
}): GitBranchContextMenuItem[] {
  const t = i18next.t.bind(i18next);
  const branch = input.branch;
  const hasRemote = (input.capabilities?.remotes.length ?? 0) > 0;
  const hasHead = input.capabilities?.hasHEAD ?? false;
  const hasUpstream = branch?.upstream != null;
  return [
    { id: "fetch", label: t("files:git.branchPopover.fetchNow"), disabled: !hasRemote, reason: t("files:git.branchPopover.addRemoteFirst") },
    {
      id: "pull",
      label: t("files:git.branchPopover.pull"),
      disabled: !hasUpstream,
      reason: t("files:git.branchPopover.setUpstreamFirst"),
    },
    {
      id: "push",
      label: t("files:git.branchPopover.push"),
      disabled: !hasRemote || !hasHead,
      reason: !hasHead ? t("files:git.branchPopover.requiresCommit") : t("files:git.branchPopover.addRemoteFirst"),
    },
    {
      id: "publish",
      label: t("files:git.branchPopover.publishBranch"),
      disabled: hasUpstream || !hasRemote || !hasHead,
      reason: hasUpstream
        ? t("files:git.branchPopover.alreadyHasUpstream")
        : !hasHead
          ? t("files:git.branchPopover.requiresCommit")
          : t("files:git.branchPopover.addRemoteFirst"),
    },
    {
      id: "copy-upstream",
      label: t("files:git.branchPopover.copyUpstream"),
      disabled: !hasUpstream,
      reason: t("files:git.branchPopover.noUpstreamConfigured"),
    },
    { id: "autofetch", label: t("files:git.branchPopover.autofetch") },
  ];
}

export function GitBranchPopover({
  branch,
  repoPath,
  disabled = false,
  capabilities,
  autofetchIntervalMin,
  autofetchFetching = false,
  autofetchFailed = false,
  onFetch,
  onPull,
  onPush,
  onPublish,
  onSync,
  onSetAutofetchInterval,
}: GitBranchPopoverProps) {
  const [open, setOpen] = useState(false);
  const [contextPoint, setContextPoint] = useState<ContextPoint | null>(null);
  const [autofetchOpen, setAutofetchOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    setContextPoint(null);
    setAutofetchOpen(false);
  }, []);
  useDismissOnOutsideClick(wrapperRef, open || contextPoint !== null, close);

  const primaryAction = getGitBranchPrimaryAction({
    branch,
    capabilities,
    failed: autofetchFailed,
  });

  function runPrimary(): void {
    setOpen(false);
    runAction(primaryAction.id);
  }

  function runAction(action: GitBranchPrimaryActionId): void {
    switch (action) {
      case "fetch":
        onFetch();
        break;
      case "pull":
        onPull();
        break;
      case "push":
        onPush();
        break;
      case "publish":
        onPublish();
        break;
      case "sync":
        onSync();
        break;
    }
  }

  return (
    <div className="relative min-w-0 flex-1" ref={wrapperRef}>
      <BranchChip
        branch={branch}
        repoPath={repoPath}
        disabled={disabled}
        open={open}
        onClick={() => setOpen((value) => !value)}
        onContextMenu={(event) => {
          event.preventDefault();
          setContextPoint({ x: event.clientX, y: event.clientY });
          setOpen(false);
        }}
      />
      {open ? (
        <div
          role="dialog"
          aria-label={i18next.t("files:git.branchPopover.ariaLabel")}
          className="absolute bottom-full left-0 z-40 mb-1 w-[240px] floating-panel p-2"
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
        >
          <GitBranchPopoverContent
            branch={branch}
            repoPath={repoPath}
            disabled={disabled}
            primaryAction={primaryAction}
            autofetchFetching={autofetchFetching}
            autofetchFailed={autofetchFailed}
            onPrimary={runPrimary}
            onRetryFetch={() => {
              setOpen(false);
              onFetch();
            }}
          />
        </div>
      ) : null}
      <BranchContextMenu
        point={contextPoint}
        branch={branch}
        capabilities={capabilities}
        autofetchOpen={autofetchOpen}
        autofetchIntervalMin={autofetchIntervalMin}
        onAutofetchOpenChange={setAutofetchOpen}
        onSetAutofetchInterval={(intervalMin) => {
          close();
          onSetAutofetchInterval(intervalMin);
        }}
        onClose={() => {
          setContextPoint(null);
          setAutofetchOpen(false);
        }}
        onAction={(id) => {
          close();
          if (id === "copy-upstream") {
            if (branch?.upstream) copyText(branch.upstream);
            return;
          }
          runAction(id);
        }}
      />
    </div>
  );
}

/** Renders the popover body so the header/status layout can be unit-tested. */
export function GitBranchPopoverContent({
  branch,
  repoPath,
  disabled = false,
  primaryAction,
  autofetchFetching = false,
  autofetchFailed = false,
  onPrimary,
  onRetryFetch,
}: GitBranchPopoverContentProps) {
  const { t } = useTranslation("files");
  const branchName = branch?.current ?? t("git.branchPopover.noBranchName");

  return (
    <>
      <p className="truncate text-app-body text-foreground" title={branchName}>
        {branchName}
      </p>
      {branch?.upstream ? (
        <p className="mt-0.5 truncate text-app-ui-sm text-muted-foreground" title={branch.upstream}>
          {t("git.branchPopover.tracking", { upstream: branch.upstream })}
        </p>
      ) : (
        <p className="mt-0.5 text-app-ui-sm text-muted-foreground">{t("git.branchPopover.noUpstreamStatus")}</p>
      )}
      {repoPath ? (
        <p className="mt-1 truncate text-app-ui-sm text-muted-foreground" title={repoPath}>
          {repoPath}
        </p>
      ) : null}
      <GitBranchFetchStatus
        fetching={autofetchFetching}
        failed={autofetchFailed}
        onRetry={onRetryFetch}
      />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="mt-2 h-7 w-full"
        disabled={disabled || primaryAction.disabled}
        title={primaryAction.reason ?? primaryAction.label}
        onClick={onPrimary}
      >
        {primaryAction.label}
      </Button>
    </>
  );
}

/** Renders fetch status in the popover header area rather than the trigger glyph. */
function GitBranchFetchStatus({
  fetching,
  failed,
  onRetry,
}: {
  fetching: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation("files");
  if (fetching) {
    return (
      <div
        role="status"
        className="mt-2 flex items-center gap-2 rounded-(--radius-control) bg-muted px-2 py-1 text-app-ui-sm text-muted-foreground"
      >
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        <span>{t("git.branchPopover.fetching")}</span>
      </div>
    );
  }

  if (!failed) return null;

  return (
    <div
      role="alert"
      className="mt-2 flex items-center justify-between gap-2 rounded-(--radius-control) bg-muted px-2 py-1 text-app-ui-sm text-muted-foreground"
    >
      <span>{t("git.branchPopover.fetchFailed")}</span>
      <button
        type="button"
        className="rounded-(--radius-control) px-1 text-foreground hover:bg-[var(--state-hover-bg)] focus-visible:bg-[var(--state-hover-bg)] focus-visible:outline-none"
        onClick={onRetry}
      >
        {t("git.branchPopover.retry")}
      </button>
    </div>
  );
}

/** Renders the fixed right-click menu for BranchChip. */
function BranchContextMenu({
  point,
  branch,
  capabilities,
  autofetchOpen,
  autofetchIntervalMin,
  onAutofetchOpenChange,
  onSetAutofetchInterval,
  onAction,
  onClose,
}: {
  point: ContextPoint | null;
  branch: BranchInfo | null;
  capabilities?: RepoCapabilities;
  autofetchOpen: boolean;
  autofetchIntervalMin: GitAutofetchIntervalMin;
  onAutofetchOpenChange: (open: boolean) => void;
  onSetAutofetchInterval: (intervalMin: GitAutofetchIntervalMin) => void;
  onAction: (id: Exclude<GitBranchContextMenuItem["id"], "autofetch">) => void;
  onClose: () => void;
}) {
  if (!point) return null;
  const items = buildGitBranchContextMenuModel({ branch, capabilities });
  return (
    <div
      role="menu"
      className="fixed z-50 min-w-[188px] floating-panel p-1"
      style={contextMenuStyle(point)}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      {items.map((item) =>
        item.id === "autofetch" ? (
          <BranchAutofetchSubmenu
            key={item.id}
            open={autofetchOpen}
            selected={autofetchIntervalMin}
            onOpenChange={onAutofetchOpenChange}
            onSelect={onSetAutofetchInterval}
          />
        ) : (
          <ContextMenuButton
            key={item.id}
            label={item.label}
            disabled={item.disabled}
            title={item.reason ?? item.label}
            onClick={() =>
              onAction(item.id as Exclude<GitBranchContextMenuItem["id"], "autofetch">)
            }
          />
        ),
      )}
    </div>
  );
}

/** Renders the nested Autofetch submenu for the branch context menu. */
function BranchAutofetchSubmenu({
  open,
  selected,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  selected: GitAutofetchIntervalMin;
  onOpenChange: (open: boolean) => void;
  onSelect: (intervalMin: GitAutofetchIntervalMin) => void;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 rounded-(--radius-control) px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-[var(--state-hover-bg)] focus-visible:bg-[var(--state-hover-bg)] focus-visible:outline-none"
        onClick={() => onOpenChange(!open)}
      >
        <span>{i18next.t("files:git.branchPopover.autofetch")}</span>
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </button>
      {open ? (
        <div role="menu" className="absolute left-full top-0 z-50 min-w-[188px] floating-panel p-1">
          {buildAutofetchMenuModel(selected).map((item) => (
            <ContextMenuButton
              key={item.intervalMin}
              label={`${item.selected ? "✓ " : ""}${item.label}`}
              onClick={() => onSelect(item.intervalMin)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Renders one branch context menu row. */
function ContextMenuButton({
  label,
  disabled,
  title,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      className="flex w-full rounded-(--radius-control) px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-[var(--state-hover-bg)] focus-visible:bg-[var(--state-hover-bg)] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** Keeps the fixed context menu inside the viewport when possible. */
function contextMenuStyle(point: ContextPoint): React.CSSProperties {
  if (typeof window === "undefined") return { left: point.x, top: point.y };
  return {
    left: Math.max(4, Math.min(point.x, window.innerWidth - 196)),
    top: Math.max(4, Math.min(point.y, window.innerHeight - 240)),
  };
}
