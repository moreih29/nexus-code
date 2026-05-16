/**
 * Pure Source Control panel action helpers that keep prompt copy and history
 * retargeting testable without rendering the full GitPanel.
 */
import type { Tag } from "../../../../../shared/git/types";
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
  const remote = remotes[0]?.trim();
  if (!remote) return null;

  const otherRemotes = remotes.slice(1).filter((name) => name.trim().length > 0);
  const remoteCopy =
    otherRemotes.length > 0
      ? ` This uses the first configured remote; ${otherRemotes.join(", ")} will not be used.`
      : "";

  return {
    title: "Publish branch?",
    description: `'${branchName}' has no upstream branch. Publish to '${remote}'?${remoteCopy}`,
    confirmLabel: "Publish",
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
  return `Showing History for tag '${tag.name}' at ${tag.sha.slice(0, 7)}.`;
}
