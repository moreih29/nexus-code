import i18next from "i18next";
import type { Tag } from "../../../../../shared/git/types";
import { isAuthGitError } from "../../../../services/error-surface/git-error-placement";
import { openTerminal } from "../../../../services/terminal";
import type { GitStoreError } from "../../../../state/stores/git";
import type { PromptRequest } from "../../../ui/prompt-dialog";

export function buildPublishBranchPrompt(
  branchName: string,
  remotes: readonly string[],
): PromptRequest | null {
  const t = i18next.t.bind(i18next);
  const remote = remotes[0]?.trim();
  if (!remote) return null;

  const otherRemotes = remotes.slice(1).filter((name) => name.trim().length > 0);
  const remoteCopy =
    otherRemotes.length > 0
      ? t("files:git.publish.descriptionMultiRemote", { others: otherRemotes.join(", ") })
      : "";

  return {
    title: t("files:git.publish.title"),
    description: `${t("files:git.publish.description", { branch: branchName, remote })}${remoteCopy}`,
    confirmLabel: t("files:git.publish.confirmLabel"),
    inputMode: "none",
  };
}

export function tagHistoryRef(tag: Pick<Tag, "name">): string {
  return `refs/tags/${tag.name}`;
}

export function buildTagHistoryRevealMessage(tag: Pick<Tag, "name" | "sha">): string {
  return i18next.t("files:git.panelActions.tagReveal", {
    name: tag.name,
    sha: tag.sha.slice(0, 7),
  });
}

export function buildErrorAction(
  error: GitStoreError | null | undefined,
  opts: { workspaceId: string; cwd?: string; onRetry: () => void },
): { label: string; onAction: () => void } {
  const cwd = opts.cwd;
  const t = i18next.t.bind(i18next);
  if (error && isAuthGitError(error) && cwd) {
    return {
      label: t("files:git.panelActions.openTerminal"),
      onAction: () => {
        openTerminal({ workspaceId: opts.workspaceId, cwd });
      },
    };
  }

  return { label: t("common:action.retry"), onAction: opts.onRetry };
}
