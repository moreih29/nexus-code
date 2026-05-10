/**
 * Surgical preflight helpers for GitRepository operations.
 *
 * After the stderr classification catalog covered the common precondition
 * failures (`no-remote`, `no-upstream`, `empty-stash` — see git-error.ts),
 * preflight collapsed to the cases where running git first would either be
 * wasteful (the resolution is purely about ref routing) or where the
 * intent itself requires a structured value the caller has to construct
 * before invoking git.
 *
 * Operation matrix:
 *
 *   - assertHasHead         → no-head, hint: make-initial-commit
 *                              Used only by `push --publish` to fail fast
 *                              before constructing `push -u <remote>
 *                              <branch>` with a missing branch name.
 *   - resolveCheckoutTarget  → returns a routed action so the caller can
 *                              fall back from a missing local ref to
 *                              `checkout --track` when the remote half
 *                              exists. The auto-promotion is a feature,
 *                              not a guard, and has no stderr equivalent.
 *
 * Other preconditions (no-remote, no-upstream, empty-stash, no-local-changes)
 * are now classified from git's stderr and surface with the same typed kinds.
 * The renderer keeps the same UI gating via `RepoCapabilities` so users do
 * not normally hit those paths.
 */

import type { BranchInfo, BranchList, GitActionHint } from "../../shared/types/git";
import { GitError } from "./git-error";

/**
 * Throws when the repository has no commits yet (`git init` without a
 * commit). Used by `push --publish` to fail before building a `-u <remote>
 * <branch>` argv with no branch name; the operation could only fail
 * downstream anyway, but doing it here gives the renderer a typed hint.
 */
export function assertHasHead(branch: BranchInfo | null): void {
  if (branch && !branch.isUnborn) return;
  throw new GitError(
    "no-head",
    "Repository has no commits yet — make an initial commit first.",
    {
      hint: { kind: "make-initial-commit" } satisfies GitActionHint,
    },
  );
}

/**
 * Resolution emitted by `resolveCheckoutTarget` so the caller can dispatch
 * to the right git command without a second round of branch lookup.
 */
export type CheckoutResolution =
  | { kind: "local"; ref: string }
  | { kind: "track"; remoteRef: string };

/**
 * Decides how to run a checkout when the user supplies a bare ref. If the
 * ref matches a local branch, the caller runs `git checkout <ref>`; if it
 * is unique to one remote (`<remote>/<ref>`), the caller runs `git checkout
 * --track <remoteRef>` so a tracking branch lands deterministically. When
 * the ref is missing entirely or appears under multiple remotes, this
 * throws a `no-such-ref` error with a hint that lets the renderer offer
 * either "Checkout origin/<ref>" or a remote chooser.
 *
 * The function does not match against tags or commit-ish — those still go
 * through `git` directly and surface as `missing` if not resolvable.
 */
export function resolveCheckoutTarget(
  ref: string,
  list: BranchList,
): CheckoutResolution {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    throw new GitError("no-such-ref", "Checkout ref is required.");
  }

  if (list.local.includes(trimmed)) {
    return { kind: "local", ref: trimmed };
  }

  const remoteMatches = list.remote.filter(
    (full) => stripRemotePrefix(full) === trimmed,
  );

  if (remoteMatches.length === 1) {
    return { kind: "track", remoteRef: remoteMatches[0] };
  }

  if (remoteMatches.length > 1) {
    throw new GitError(
      "no-such-ref",
      `'${trimmed}' is ambiguous — multiple remotes provide it.`,
      {
        hint: {
          kind: "ambiguous-remote",
          candidates: remoteMatches,
        } satisfies GitActionHint,
      },
    );
  }

  throw new GitError(
    "no-such-ref",
    `Branch '${trimmed}' does not exist locally or on any remote.`,
  );
}

/**
 * Strips the `<remote>/` segment from a `git branch --remotes` short ref.
 * Mirrors the helper in branch-picker-source.ts; duplicated here to keep
 * this module main-process pure (no renderer imports).
 */
function stripRemotePrefix(remoteRef: string): string {
  const slash = remoteRef.indexOf("/");
  return slash >= 0 ? remoteRef.slice(slash + 1) : remoteRef;
}
