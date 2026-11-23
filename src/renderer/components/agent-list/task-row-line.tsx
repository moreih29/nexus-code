// Agent list — the task view's compact row and worktree header as drawn,
// apart from where their facts come from: this computer's sessions and
// worktrees, or another computer's as it lists them.

import { ChevronDown, ChevronRight, FileDiff, Folder, GitBranch } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { Button } from "../ui/button";

/**
 * A conversation in a line: its mark and title, what follows the title
 * (its branch, parent, what it waits on), its children's chip, its state
 * and how long. The title keeps the room it needs first; what follows it
 * goes out of sight where it would not fit beside it.
 */
export function TaskRowLine({
  mark,
  title,
  tooltip,
  emphasized,
  tags,
  family,
  sign,
  duration,
  durationClass,
  selected,
  onSelect,
  testId,
  sessionKey,
  ...button
}: {
  mark: ReactNode;
  title: string;
  /** The button's hover text; the title by default. */
  tooltip?: string;
  /** Needs attention, runs or has a new result. */
  emphasized: boolean;
  tags?: ReactNode;
  family?: ReactNode;
  sign: ReactNode;
  duration?: string | null;
  durationClass?: string;
  selected: boolean;
  /** Picked, with its row. */
  onSelect: (from: HTMLElement) => void;
  testId: string;
  sessionKey?: string;
} & Omit<ComponentProps<"button">, "type" | "onClick" | "children" | "title" | "onSelect">) {
  return (
    <div
      className={cn(
        "relative flex h-7 w-full min-w-0 items-center gap-2 px-2 text-app-ui-sm transition-colors",
        selected ? "bg-[var(--sidebar-item-selected-bg)]" : "hover:bg-[var(--state-hover-bg)]",
      )}
      data-testid={testId}
      data-session-key={sessionKey}
    >
      {/* The row as one button behind its content, so its chips stay buttons. */}
      <button
        type="button"
        aria-label={title}
        {...button}
        title={tooltip ?? title}
        onClick={(event) => onSelect(event.currentTarget)}
        className="absolute inset-0 outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset data-[state=open]:bg-[var(--state-hover-bg)]"
      />
      <span className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-2">
        {mark}
        <span className="flex h-5 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden">
          <span
            className={cn(
              "h-5 min-w-0 flex-[1_1_8em] truncate",
              emphasized ? "font-medium text-foreground" : "text-foreground/90",
            )}
          >
            {title}
          </span>
          {tags && (
            <span className="flex h-5 max-w-full min-w-0 shrink-0 items-center gap-2 text-app-micro text-muted-foreground">
              {tags}
            </span>
          )}
        </span>
        {family}
        <span className="flex shrink-0 items-center gap-1">
          {sign}
          {duration && (
            <span className={cn("text-app-micro tabular-nums", durationClass)}>{duration}</span>
          )}
        </span>
      </span>
    </div>
  );
}

/**
 * A worktree's header: its name, its branch for the workspace itself, the
 * conversation that made it and its changes, folding its facts open or
 * shut. Under the pointer, or with the keyboard in it, the changes give
 * way to what can be done in it, where anything can.
 */
export function TaskHeaderLine({
  name,
  isRoot,
  branch,
  creator,
  changed,
  unfolded,
  onToggle,
  actions,
  menuOpen = false,
  testId,
}: {
  name: string;
  isRoot: boolean;
  /** The workspace's branch; a task's is its name. */
  branch?: string;
  creator?: ReactNode;
  changed: number;
  unfolded: boolean;
  onToggle: () => void;
  /** Its buttons, shown in place of the changes. */
  actions?: ReactNode;
  /** A menu of its actions is open: they stay. */
  menuOpen?: boolean;
  testId: string;
}) {
  const { t } = useTranslation();
  const Chevron = unfolded ? ChevronDown : ChevronRight;
  const Icon = isRoot ? Folder : GitBranch;
  const chip = isRoot ? branch : undefined;
  return (
    <div
      className="group/task relative flex min-w-0 items-center gap-2 px-3 py-2 text-app-ui-sm transition-colors hover:bg-[var(--state-hover-bg)]"
      data-testid={testId}
    >
      {/* The header as one button behind its content, so its actions stay buttons. */}
      <button
        type="button"
        aria-expanded={unfolded}
        aria-label={name}
        onClick={onToggle}
        className="absolute inset-0 outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
      />
      <div className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-2">
        <Chevron aria-hidden className="-ml-1 size-3.5 shrink-0 text-muted-foreground" />
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        {/* The name keeps its width beside the branch or the creator, which
            give way first, up to most of the line. */}
        <span
          className={cn(
            "truncate font-medium text-foreground",
            chip || creator ? "max-w-[70%] shrink-0" : "min-w-0",
          )}
          title={name}
        >
          {name}
        </span>
        {chip && (
          <span
            className="flex min-w-0 shrink items-center gap-1 rounded-(--radius-control) bg-muted px-1.5 font-mono text-app-micro text-muted-foreground @max-xs/agents:hidden"
            title={chip}
          >
            <GitBranch aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{chip}</span>
          </span>
        )}
        {creator}
      </div>
      {changed > 0 && (
        <span
          className={cn(
            "pointer-events-none relative flex shrink-0 items-center gap-1 text-app-micro text-muted-foreground tabular-nums",
            actions &&
              (menuOpen ? "hidden" : "group-focus-within/task:hidden group-hover/task:hidden"),
          )}
          title={t("agentList.detail.changes", { count: changed })}
        >
          <FileDiff aria-hidden className="size-3.5" />
          {changed}
        </span>
      )}
      {/* The buttons stand over the header's padding, so showing them does
          not make the line taller than its text. */}
      {actions && (
        <div
          className={cn(
            "relative -my-1 shrink-0 items-center gap-0.5",
            menuOpen ? "flex" : "hidden group-focus-within/task:flex group-hover/task:flex",
          )}
        >
          {actions}
        </div>
      )}
    </div>
  );
}

/** One of a worktree header's actions, as an icon with its name for a title. */
export function TaskHeaderAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      className="size-6"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
