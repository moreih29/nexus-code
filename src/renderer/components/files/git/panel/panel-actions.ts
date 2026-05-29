/**
 * Pure Source Control panel action helpers that keep prompt copy and history
 * retargeting testable without rendering the full GitPanel.
 */
import i18next from "i18next";
import type { Tag } from "../../../../../shared/git/types";
import { openTerminal } from "../../../../services/terminal";
import type { GitStoreError } from "../../../../state/stores/git";
import type { PromptRequest } from "../../../ui/prompt-dialog";

/**
 * Builds the publish confirmation for the implementation's actual behavior:
 * `publish: true` publishes to the first configured remote. The prompt is
 * intentionally confirm-only so a multi-remote user cannot edit a value that
 * the main process will not honor.
 */
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

/**
 * Returns the full tag ref used by the History panel so tag names that collide
 * with branch names still resolve as tags.
 */
export function tagHistoryRef(tag: Pick<Tag, "name">): string {
  return `refs/tags/${tag.name}`;
}

/**
 * Builds the banner shown after a tag reveal retargets History.
 */
export function buildTagHistoryRevealMessage(tag: Pick<Tag, "name" | "sha">): string {
  return i18next.t("files:git.panelActions.tagReveal", { name: tag.name, sha: tag.sha.slice(0, 7) });
}

/**
 * Authentication failures keep a terminal escape hatch for credential helpers
 * that cannot be represented by the askpass dialog. Other failures keep the
 * local retry affordance.
 */
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

  return { label: t("files:common.action.retry"), onAction: opts.onRetry };
}

/**
 * Branches on stable GitError.kind when available, with message fallback for
 * Electron IPC error serialization that can strip custom Error properties.
 */
function isAuthGitError(error: GitStoreError): boolean {
  if (error.kind === "auth" || error.kind === "auth-required") return true;
  return /authentication failed|could not read username|could not read password|permission denied|terminal prompts disabled/i.test(
    `${error.message}\n${error.details ?? ""}`,
  );
}
