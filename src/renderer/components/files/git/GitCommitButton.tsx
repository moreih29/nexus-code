/**
 * GitCommitButton renders the Source Control split action button.
 */
import { Check, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type { GitCommitOptions } from "../../../../shared/types/git";
import type {
  GitActionButtonState,
  GitActionMenuMode,
} from "../../../state/selectors/git-action-button";
import { Button } from "../../ui/button";
import { useDismissOnOutsideClick } from "../../ui/use-dismiss-on-outside-click";

export interface GitCommitMenuEnablement {
  readonly canCommitStaged: boolean;
  readonly canCommitAll: boolean;
  readonly canCommitAndPush: boolean;
  readonly canPush: boolean;
  readonly canPull: boolean;
}

export interface GitCommitButtonProps {
  action: GitActionButtonState;
  busy?: boolean;
  commitOptions: GitCommitOptions;
  enablement: GitCommitMenuEnablement;
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

export type GitCommitMenuSpec =
  | { kind: "item"; id: string; label: string; disabled?: boolean; destructive?: boolean }
  | { kind: "separator" }
  | { kind: "submenu"; id: string; label: string; items: GitCommitOptionMenuSpec[] };

export interface GitCommitOptionMenuSpec {
  readonly id: keyof GitCommitOptions;
  readonly label: string;
  readonly checked: boolean;
}

/** Builds the chevron menu model for commit-state and sync-state actions. */
export function buildGitCommitMenuModel(input: {
  readonly mode: GitActionMenuMode;
  readonly commitOptions: GitCommitOptions;
  readonly enablement: GitCommitMenuEnablement;
}): GitCommitMenuSpec[] {
  if (input.mode === "none") return [];
  if (input.mode === "sync") {
    return [
      { kind: "item", id: "push-only", label: "Push only", disabled: !input.enablement.canPush },
      { kind: "item", id: "pull-only", label: "Pull only", disabled: !input.enablement.canPull },
    ];
  }

  return [
    {
      kind: "item",
      id: "commit-staged",
      label: "Commit Staged",
      disabled: !input.enablement.canCommitStaged,
    },
    {
      kind: "item",
      id: "commit-all",
      label: "Commit All",
      disabled: !input.enablement.canCommitAll,
    },
    { kind: "item", id: "amend", label: "Amend Last Commit" },
    {
      kind: "item",
      id: "commit-and-push",
      label: "Commit & Push",
      disabled: !input.enablement.canCommitAndPush,
    },
    { kind: "item", id: "commit-empty", label: "Commit Empty" },
    { kind: "separator" },
    { kind: "item", id: "undo-last-commit", label: "Undo Last Commit", destructive: true },
    { kind: "separator" },
    {
      kind: "submenu",
      id: "commit-options",
      label: "Commit Options",
      items: [
        { id: "sign", label: "Sign", checked: input.commitOptions.sign },
        { id: "signoff", label: "Signoff", checked: input.commitOptions.signoff },
        { id: "noVerify", label: "Skip hooks", checked: input.commitOptions.noVerify },
      ],
    },
  ];
}

/** Renders the split action and its dynamic chevron menu. */
export function GitCommitButton({
  action,
  busy = false,
  commitOptions,
  enablement,
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
}: GitCommitButtonProps) {
  const [open, setOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    setOptionsOpen(false);
  }, []);
  useDismissOnOutsideClick(wrapperRef, open, close);

  const menu = buildGitCommitMenuModel({ mode: action.menuMode, commitOptions, enablement });
  const chevronDisabled = busy || menu.length === 0;

  function run(actionFn: () => void): void {
    close();
    actionFn();
  }

  function runMenuItem(id: string): void {
    switch (id) {
      case "commit-staged":
        run(onCommitStaged);
        break;
      case "commit-all":
        run(onCommitAll);
        break;
      case "amend":
        run(onAmend);
        break;
      case "commit-and-push":
        run(onCommitAndPush);
        break;
      case "commit-empty":
        run(onCommitEmpty);
        break;
      case "undo-last-commit":
        run(onUndoLastCommit);
        break;
      case "push-only":
        run(onPushOnly);
        break;
      case "pull-only":
        run(onPullOnly);
        break;
    }
  }

  return (
    <div className="relative flex w-full" ref={wrapperRef}>
      <Button
        type="button"
        variant="default"
        size="sm"
        className="h-7 min-w-0 flex-1 rounded-r-none text-app-ui-sm"
        disabled={busy || action.disabled}
        title={action.hint}
        onClick={onPrimaryAction}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
        <span className="truncate">{action.label}</span>
      </Button>
      <Button
        type="button"
        variant="default"
        size="icon-sm"
        className="h-7 w-8 rounded-l-none border-l border-mist-border/50"
        aria-label="Show source control action menu"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={chevronDisabled}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-8 z-40 min-w-[188px] rounded border border-mist-border bg-popover p-1 text-popover-foreground shadow-sm"
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
        >
          {menu.map((item, index) => {
            if (item.kind === "separator") {
              return <MenuSeparator key={`separator-${previousMenuItemId(menu, index)}`} />;
            }
            if (item.kind === "submenu") {
              return (
                <CommitOptionsSubmenu
                  key={item.id}
                  label={item.label}
                  open={optionsOpen}
                  items={item.items}
                  onOpenChange={setOptionsOpen}
                  onToggle={(option, value) => onToggleCommitOption(option, value)}
                />
              );
            }
            return (
              <MenuButton
                key={item.id}
                label={item.label}
                disabled={item.disabled}
                destructive={item.destructive}
                onClick={() => runMenuItem(item.id)}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** Renders one clickable menu item with GitMoreMenu's visual treatment. */
function MenuButton({
  label,
  disabled,
  destructive,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
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

/** Renders the Commit Options flyout with sticky checkbox menu items. */
function CommitOptionsSubmenu({
  label,
  open,
  items,
  onOpenChange,
  onToggle,
}: {
  label: string;
  open: boolean;
  items: GitCommitOptionMenuSpec[];
  onOpenChange: (open: boolean) => void;
  onToggle: <K extends keyof GitCommitOptions>(option: K, value: GitCommitOptions[K]) => void;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 rounded-[3px] px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-frosted-veil-strong focus-visible:bg-frosted-veil-strong focus-visible:outline-none"
        onClick={() => onOpenChange(!open)}
      >
        <span>{label}</span>
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute left-full top-0 z-50 min-w-[152px] rounded border border-mist-border bg-popover p-1 text-popover-foreground shadow-sm"
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={item.checked}
              className="flex w-full items-center gap-2 rounded-[3px] px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-frosted-veil-strong focus-visible:bg-frosted-veil-strong focus-visible:outline-none"
              onClick={() => onToggle(item.id, !item.checked)}
            >
              <span className="flex size-3.5 items-center justify-center">
                {item.checked ? <Check className="size-3.5" aria-hidden="true" /> : null}
              </span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Renders the separator shared by commit and sync menus. */
function MenuSeparator() {
  return <hr className="my-1 h-px border-0 bg-mist-border" />;
}

/** Finds the nearest previous concrete menu id to key a separator. */
function previousMenuItemId(menu: GitCommitMenuSpec[], index: number): string {
  for (let i = index - 1; i >= 0; i -= 1) {
    const item = menu[i];
    if (item.kind !== "separator") return item.id;
  }
  return "leading";
}
