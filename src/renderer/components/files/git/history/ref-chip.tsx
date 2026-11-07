/**
 * Ref chips render compact git decorations beside a commit subject and expose
 * branch/tag navigation without changing the row context-menu behavior.
 */
import i18next from "i18next";
import { GitBranch, Tag } from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";
import type { LogEntryRef } from "../../../../../shared/git/types";
import { cn } from "../../../../utils/cn";
import { Popover } from "../../../ui/popover";

const DEFAULT_VISIBLE_REF_COUNT = 2;

export type RefChipDisplayKind = "head" | "current" | "branch" | "remote" | "tag";
export type RefChipVisibleCount = 1 | 2;
export type RefChipListBreakpoint = "compact" | "narrow" | "medium" | "wide";
export type RefChipContextMenuHandler = (
  event: React.MouseEvent<HTMLElement>,
  refInfo?: LogEntryRef,
) => void;

export interface RefChipProps {
  readonly refInfo: LogEntryRef;
  readonly currentRefName?: string;
  readonly className?: string;
  readonly iconOnly?: boolean;
  readonly onRefChange: (refName: string) => void;
  readonly onOpenMenu?: RefChipContextMenuHandler;
}

export interface RefChipListProps {
  readonly refs: readonly LogEntryRef[] | undefined;
  readonly currentRefName?: string;
  readonly breakpoint?: RefChipListBreakpoint;
  readonly visibleCount?: RefChipVisibleCount;
  readonly onRefChange: (refName: string) => void;
  readonly onOpenMenu?: RefChipContextMenuHandler;
}

/** Renders one focusable ref decoration chip with a 14ch truncation cap. */
export function RefChip({
  refInfo,
  currentRefName,
  className,
  iconOnly = false,
  onRefChange,
  onOpenMenu,
}: RefChipProps) {
  const displayKind = refChipDisplayKind(refInfo, currentRefName);
  const showIconOnly = iconOnly && displayKind === "head";

  /** Navigates to the chip ref without also selecting the commit row. */
  function handleClick(event: React.MouseEvent<HTMLButtonElement>): void {
    event.stopPropagation();
    onRefChange(refInfo.name);
  }

  /** Keeps right-clicks on chips wired to the existing commit menu. */
  function handleContextMenu(event: React.MouseEvent<HTMLButtonElement>): void {
    event.preventDefault();
    event.stopPropagation();
    onOpenMenu?.(event, refInfo);
  }

  return (
    <button
      type="button"
      title={refInfo.name}
      className={cn(refChipClassName(displayKind, showIconOnly), className)}
      aria-label={refChipAriaLabel(refInfo, displayKind)}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      <RefChipIcon displayKind={displayKind} />
      {showIconOnly ? null : <span className="min-w-0 truncate">{refInfo.name}</span>}
    </button>
  );
}

/** Renders prioritized visible ref chips plus a popover for the overflow. */
export function RefChipList({
  refs,
  currentRefName,
  breakpoint,
  visibleCount = DEFAULT_VISIBLE_REF_COUNT,
  onRefChange,
  onOpenMenu,
}: RefChipListProps) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const orderedRefs = useMemo(
    () => sortRefsForDisplay(refs ?? [], currentRefName),
    [currentRefName, refs],
  );
  const normalizedVisibleCount = visibleCountForBreakpoint(breakpoint, visibleCount);
  const headRef = orderedRefs.find(
    (refInfo) => refChipDisplayKind(refInfo, currentRefName) === "head",
  );
  const visibleRefs = orderedRefs.slice(0, normalizedVisibleCount);
  const overflowRefs = orderedRefs.slice(normalizedVisibleCount);

  if (orderedRefs.length === 0) return null;
  if (breakpoint === "compact" || breakpoint === "narrow") {
    if (!headRef) return null;
    return (
      <span className="inline-flex min-w-0 items-center">
        <RefChip
          refInfo={headRef}
          currentRefName={currentRefName}
          iconOnly
          onRefChange={onRefChange}
          onOpenMenu={onOpenMenu}
        />
      </span>
    );
  }

  /** Forwards right-click on the overflow trigger to the commit menu. */
  function handleOverflowContextMenu(event: React.MouseEvent<HTMLButtonElement>): void {
    event.preventDefault();
    event.stopPropagation();
    setOverflowOpen(false);
    onOpenMenu?.(event);
  }

  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {visibleRefs.map((refInfo) => (
        <RefChip
          key={refChipKey(refInfo)}
          refInfo={refInfo}
          currentRefName={currentRefName}
          onRefChange={onRefChange}
          onOpenMenu={onOpenMenu}
        />
      ))}
      {overflowRefs.length > 0 ? (
        <Popover
          open={overflowOpen}
          onOpenChange={setOverflowOpen}
          label={i18next.t("files:git.refChip.moreRefs")}
          side="bottom"
          align="start"
          className="flex max-h-60 max-w-60 flex-col gap-1"
          containEvents
          trigger={
            <button
              type="button"
              className="inline-flex h-5 shrink-0 items-center rounded-full border border-[var(--color-git-chip-border)] px-2 text-app-ui-sm text-muted-foreground hover:bg-[var(--color-git-chip-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              aria-label={i18next.t("files:git.refChip.showMoreRefs", {
                count: overflowRefs.length,
              })}
              // The row under it would select the commit too.
              onClick={(event) => event.stopPropagation()}
              onContextMenu={handleOverflowContextMenu}
            >
              +{overflowRefs.length}
            </button>
          }
        >
          {overflowRefs.map((refInfo) => (
            <RefChip
              key={refChipKey(refInfo)}
              refInfo={refInfo}
              currentRefName={currentRefName}
              className="w-full max-w-none justify-start"
              onRefChange={(refName) => {
                setOverflowOpen(false);
                onRefChange(refName);
              }}
              onOpenMenu={(event, openedRef) => {
                setOverflowOpen(false);
                onOpenMenu?.(event, openedRef);
              }}
            />
          ))}
        </Popover>
      ) : null}
    </span>
  );
}

/** Sorts refs by the agreed display priority while preserving Git order ties. */
export function sortRefsForDisplay(
  refs: readonly LogEntryRef[],
  currentRefName?: string,
): LogEntryRef[] {
  return refs
    .map((refInfo, index) => ({
      refInfo,
      index,
      priority: refChipPriority(refChipDisplayKind(refInfo, currentRefName)),
    }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ refInfo }) => refInfo);
}

/** Maps schema refs into the five visual chip kinds used by the history row. */
export function refChipDisplayKind(
  refInfo: LogEntryRef,
  currentRefName?: string,
): RefChipDisplayKind {
  if (refInfo.kind === "head") return "head";
  if (refInfo.kind === "branch" && (refInfo.isHead || refInfo.name === currentRefName)) {
    return "current";
  }
  return refInfo.kind;
}

/** Renders the icon/marker that differentiates the five chip display kinds. */
function RefChipIcon({ displayKind }: { displayKind: RefChipDisplayKind }) {
  if (displayKind === "head") {
    return <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />;
  }
  if (displayKind === "tag") {
    return (
      <Tag className="size-3 shrink-0" aria-hidden="true" style={refChipIconStyle(displayKind)} />
    );
  }
  return (
    <GitBranch
      className="size-3 shrink-0"
      aria-hidden="true"
      style={refChipIconStyle(displayKind)}
    />
  );
}

/** Returns the restrained shape/fill treatment for one visual ref kind. */
function refChipClassName(displayKind: RefChipDisplayKind, iconOnly = false): string {
  const baseClassName = cn(
    "inline-flex h-5 min-w-0 shrink-0 items-center border text-app-ui-sm leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
    iconOnly ? "w-5 justify-center px-0" : "max-w-[14ch] gap-1 px-2",
  );

  if (displayKind === "head") {
    return cn(
      baseClassName,
      "rounded-full border-transparent bg-[var(--color-git-chip-head-bg)] text-[var(--color-git-chip-head-fg)]",
    );
  }

  if (displayKind === "current") {
    return cn(
      baseClassName,
      "rounded-full border-[var(--color-git-chip-border-strong)] bg-[var(--color-git-chip-hover-bg)] text-foreground hover:bg-[var(--color-git-chip-hover-bg)]",
    );
  }

  if (displayKind === "remote") {
    return cn(
      baseClassName,
      "rounded-md border-dashed border-[var(--color-git-chip-border)] text-muted-foreground hover:bg-[var(--color-git-chip-hover-bg)] hover:text-foreground",
    );
  }

  if (displayKind === "tag") {
    return cn(
      baseClassName,
      "rounded-[3px] border-[var(--color-git-chip-border)] text-muted-foreground hover:bg-[var(--color-git-chip-hover-bg)] hover:text-foreground",
    );
  }

  return cn(
    baseClassName,
    "rounded-full border-[var(--color-git-chip-border)] text-muted-foreground hover:bg-[var(--color-git-chip-hover-bg)] hover:text-foreground",
  );
}

/** Assigns secondary warm accent colors without making color the sole signal. */
function refChipIconStyle(displayKind: RefChipDisplayKind): React.CSSProperties {
  if (displayKind === "current") return { color: "var(--color-git-lane-0)" };
  if (displayKind === "branch") return { color: "var(--color-git-lane-2)" };
  if (displayKind === "remote") return { color: "var(--color-git-lane-4)" };
  return { color: "var(--color-git-lane-6)" };
}

/** Builds the descriptive label screen readers hear for one chip. */
function refChipAriaLabel(refInfo: LogEntryRef, displayKind: RefChipDisplayKind): string {
  const t = i18next.t.bind(i18next);
  if (displayKind === "head") return t("files:git.refChip.headRef");
  if (displayKind === "current") return t("files:git.refChip.currentBranch", { name: refInfo.name });
  if (displayKind === "branch") return t("files:git.refChip.branch", { name: refInfo.name });
  if (displayKind === "remote") return t("files:git.refChip.remoteBranch", { name: refInfo.name });
  return t("files:git.refChip.tag", { name: refInfo.name });
}

/** Gives stable keys to refs that may share a display name across namespaces. */
function refChipKey(refInfo: LogEntryRef): string {
  return `${refInfo.kind}:${refInfo.name}`;
}

/** Converts display kind into sort priority for HEAD/current/local/remote/tag. */
function refChipPriority(displayKind: RefChipDisplayKind): number {
  if (displayKind === "head") return 0;
  if (displayKind === "current") return 1;
  if (displayKind === "branch") return 2;
  if (displayKind === "remote") return 3;
  return 4;
}

/** Adapts visible ref density to the measured history list width. */
function visibleCountForBreakpoint(
  breakpoint: RefChipListBreakpoint | undefined,
  visibleCount: RefChipVisibleCount,
): RefChipVisibleCount {
  if (breakpoint === "medium") return 1;
  if (breakpoint === "wide") return DEFAULT_VISIBLE_REF_COUNT;
  return visibleCount === 1 ? 1 : DEFAULT_VISIBLE_REF_COUNT;
}
