/**
 * GitCommitButton renders the Source Control split action button.
 */
import i18next from "i18next";
import { ChevronDown, Loader2 } from "lucide-react";
import type { GitCommitOptions } from "../../../../../shared/git/types";
import type {
  GitActionButtonState,
  GitActionMenuMode,
} from "../../../../state/stores/git/action-button";
import { Button } from "../../../ui/button";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../../ui/dropdown-menu";

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
  const t = i18next.t.bind(i18next);
  if (input.mode === "none") return [];
  if (input.mode === "sync") {
    return [
      { kind: "item", id: "push-only", label: t("files:git.commit.button.menu.pushOnly"), disabled: !input.enablement.canPush },
      { kind: "item", id: "pull-only", label: t("files:git.commit.button.menu.pullOnly"), disabled: !input.enablement.canPull },
    ];
  }

  return [
    {
      kind: "item",
      id: "commit-staged",
      label: t("files:git.commit.button.menu.commitStaged"),
      disabled: !input.enablement.canCommitStaged,
    },
    {
      kind: "item",
      id: "commit-all",
      label: t("files:git.commit.button.menu.commitAll"),
      disabled: !input.enablement.canCommitAll,
    },
    { kind: "item", id: "amend", label: t("files:git.commit.button.menu.amendLast") },
    {
      kind: "item",
      id: "commit-and-push",
      label: t("files:git.commit.button.menu.commitAndPush"),
      disabled: !input.enablement.canCommitAndPush,
    },
    { kind: "item", id: "commit-empty", label: t("files:git.commit.button.menu.commitEmpty") },
    { kind: "separator" },
    { kind: "item", id: "undo-last-commit", label: t("files:git.commit.button.menu.undoLastCommit"), destructive: true },
    { kind: "separator" },
    {
      kind: "submenu",
      id: "commit-options",
      label: t("files:git.commit.button.menu.commitOptions"),
      items: [
        { id: "sign", label: t("files:git.commit.button.menu.sign"), checked: input.commitOptions.sign },
        { id: "signoff", label: t("files:git.commit.button.menu.signoff"), checked: input.commitOptions.signoff },
        { id: "noVerify", label: t("files:git.commit.button.menu.skipHooks"), checked: input.commitOptions.noVerify },
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
  const menu = buildGitCommitMenuModel({ mode: action.menuMode, commitOptions, enablement });
  const chevronDisabled = busy || menu.length === 0;
  const handlers: Record<string, () => void> = {
    "commit-staged": onCommitStaged,
    "commit-all": onCommitAll,
    amend: onAmend,
    "commit-and-push": onCommitAndPush,
    "commit-empty": onCommitEmpty,
    "undo-last-commit": onUndoLastCommit,
    "push-only": onPushOnly,
    "pull-only": onPullOnly,
  };

  return (
    <div className="flex w-full">
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
      <DropdownMenuRoot modal={false}>
        <DropdownMenuTrigger>
          <Button
            type="button"
            variant="default"
            size="icon-sm"
            className="h-7 w-8 rounded-l-none border-l border-border/50"
            aria-label={i18next.t("files:git.commit.button.ariaLabel")}
            disabled={chevronDisabled}
          >
            <ChevronDown className="size-3.5" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {menu.map((item, index) => {
            if (item.kind === "separator") {
              return (
                <DropdownMenuSeparator key={`separator-${previousMenuItemId(menu, index)}`} />
              );
            }
            if (item.kind === "submenu") {
              return (
                <DropdownMenuSub key={item.id}>
                  <DropdownMenuSubTrigger>{item.label}</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {item.items.map((option) => (
                      <DropdownMenuCheckboxItem
                        key={option.id}
                        checked={option.checked}
                        onCheckedChange={(checked) => onToggleCommitOption(option.id, checked)}
                      >
                        {option.label}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              );
            }
            return (
              <DropdownMenuItem
                key={item.id}
                disabled={item.disabled}
                className={item.destructive ? "git-destructive-text" : undefined}
                onSelect={handlers[item.id]}
              >
                {item.label}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenuRoot>
    </div>
  );
}

/** Finds the nearest previous concrete menu id to key a separator. */
function previousMenuItemId(menu: GitCommitMenuSpec[], index: number): string {
  for (let i = index - 1; i >= 0; i -= 1) {
    const item = menu[i];
    if (item.kind !== "separator") return item.id;
  }
  return "leading";
}
