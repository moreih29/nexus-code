/**
 * Main-process wrapper around one repository. The repository root is the Git
 * toplevel, which may be above the opened workspace when a subdirectory is open.
 */

import { StringDecoder } from "node:string_decoder";
import type {
  BranchList,
  CommitDetail,
  CommitResult,
  CommitSearchResult,
  DiffChunk,
  DiffComplete,
  DiffSpec,
  GitCherryPickResult,
  GitContinueOpResult,
  GitExpandedGroupKey,
  GitFastForwardResult,
  GitLogScope,
  GitMarkResolvedResult,
  GitMergeMode,
  GitMergeResult,
  GitRebaseResult,
  GitStatus,
  GitSyncResult,
  LogChunk,
  LogComplete,
  LogEntry,
  PullResult,
  PushResult,
  RemoteTag,
  RepoCapabilities,
  Tag,
} from "../../shared/types/git";
import type { GitBinary } from "./git-binary";
import { readAtHead, streamBlob } from "./git-blob";
import * as branchOps from "./git-branch-ops";
import { buildCommitDetailArgs, parseCommitDetailOutput } from "./git-commit-detail";
import { type GitConflictRunner, markResolved as markConflictResolved } from "./git-conflict";
import { streamGitTextChunks } from "./git-diff-stream";
import { GitError } from "./git-error";
import { appendIgnoreEntry } from "./git-ignore";
import { buildLogArgs, LOG_RECORD_SEPARATOR, parseLogRecord } from "./git-log-parsing";
import { readGitOperationState } from "./git-operation-state";
import { assertHasHead, resolveCheckoutTarget } from "./git-preflight";
import { type RunGitResult, runGit, streamGit } from "./git-process";
import * as remoteOps from "./git-remote";
import {
  buildCommitArgs,
  buildDiffArgs,
  collectDiscardPathsets,
  gitSyncErrorFromGitError,
  isAbortError,
  noop,
  parseBranchLines,
  parsePullResult,
  parsePushResult,
  readFetchHeadMtime,
  throwIfAborted,
} from "./git-repository-helpers";
import {
  applyStash,
  dropStash,
  listStashes,
  popLatestStash,
  showStash,
  stashGroup,
} from "./git-stash";
import * as tagOps from "./git-tag";
import * as workflow from "./git-workflow";
import { type BuildHelperEnvOptions, buildHelperEnv } from "./helpers-launcher";
import { parseV2Porcelain } from "./porcelain-v2";

const LOG_CHUNK_ENTRY_COUNT = 50;

export interface GitLogArgs {
  readonly ref?: string;
  readonly scope?: GitLogScope;
  readonly afterSha?: string;
  readonly grep?: string;
  readonly skip?: number;
  readonly limit?: number;
}

interface QueuedOperation {
  readonly controller: AbortController;
  readonly cleanup: () => void;
}

export interface DiscardOptions {
  readonly source?: GitExpandedGroupKey;
}

export interface CommitCommandOptions {
  readonly amend?: boolean;
  readonly allowEmpty?: boolean;
  readonly edit?: boolean;
  readonly sign?: boolean;
  readonly signoff?: boolean;
  readonly noVerify?: boolean;
}

export interface DiscardPathsets {
  readonly restoreAllPaths: string[];
  readonly restoreWorktreePaths: string[];
  readonly resetIndexPaths: string[];
  readonly resetThenCleanPaths: string[];
  readonly cleanPaths: string[];
}

/**
 * Serializes all Git subprocesses for one repository and exposes typed SCM ops.
 */
export class GitRepository {
  readonly workspaceId: string;
  readonly topLevel: string;
  readonly gitDir: string;
  readonly gitVersion: string | null;

  private readonly binPath: string;
  private readonly operationControllers = new Set<AbortController>();
  private queueTail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(workspaceId: string, topLevel: string, gitDir: string, bin: GitBinary | string) {
    this.workspaceId = workspaceId;
    this.topLevel = topLevel;
    this.gitDir = gitDir;
    this.binPath = typeof bin === "string" ? bin : bin.path;
    this.gitVersion = typeof bin === "string" ? null : bin.version;
  }

  /**
   * Reads porcelain v2 status and groups entries for the Source Control panel.
   */
  status(signal?: AbortSignal): Promise<GitStatus> {
    return this.queue((queuedSignal) => this.readStatus(queuedSignal), signal);
  }

  /**
   * Stages one or more repository-relative paths.
   */
  stage(relPaths: readonly string[], signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      if (relPaths.length === 0) return;
      await this.run(["add", "--", ...relPaths], queuedSignal);
    }, signal);
  }

  /**
   * Removes one or more paths from the index while preserving working files.
   */
  unstage(relPaths: readonly string[], signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      if (relPaths.length === 0) return;
      await this.run(["reset", "-q", "--", ...relPaths], queuedSignal);
    }, signal);
  }

  /**
   * Discards tracked changes and deletes untracked paths selected by status rows.
   */
  discard(
    relPaths: readonly string[],
    options: DiscardOptions = {},
    signal?: AbortSignal,
  ): Promise<void> {
    return this.queue(async (queuedSignal) => {
      if (relPaths.length === 0) return;

      const status = await this.readStatus(queuedSignal);
      const pathsets = collectDiscardPathsets(status, relPaths, options);

      if (pathsets.resetIndexPaths.length > 0) {
        await this.run(["reset", "-q", "--", ...pathsets.resetIndexPaths], queuedSignal);
      }
      if (pathsets.restoreWorktreePaths.length > 0) {
        await this.run(
          ["restore", "--worktree", "--", ...pathsets.restoreWorktreePaths],
          queuedSignal,
        );
      }
      if (pathsets.restoreAllPaths.length > 0) {
        await this.run(
          ["restore", "--staged", "--worktree", "--", ...pathsets.restoreAllPaths],
          queuedSignal,
        );
      }
      if (pathsets.resetThenCleanPaths.length > 0) {
        await this.run(["reset", "-q", "--", ...pathsets.resetThenCleanPaths], queuedSignal);
        await this.run(["clean", "-f", "--", ...pathsets.resetThenCleanPaths], queuedSignal);
      }
      if (pathsets.cleanPaths.length > 0) {
        await this.run(["clean", "-f", "--", ...pathsets.cleanPaths], queuedSignal);
      }
    }, signal);
  }

  /**
   * Creates a commit and returns the new HEAD SHA.
   */
  commit(
    message: string,
    options: CommitCommandOptions = {},
    signal?: AbortSignal,
  ): Promise<CommitResult> {
    return this.queue(async (queuedSignal) => {
      return this.commitWithinQueue(message, options, queuedSignal);
    }, signal);
  }

  /**
   * Amends HEAD, using the Git editor helper when no inline message is given.
   */
  commitAmend(
    message: string | undefined,
    options: Omit<CommitCommandOptions, "amend"> = {},
    signal?: AbortSignal,
  ): Promise<CommitResult> {
    return this.queue(async (queuedSignal) => {
      const status = await this.readStatus(queuedSignal);
      assertHasHead(status.branch);
      const inlineMessage = message?.trim();
      return this.commitWithinQueue(
        inlineMessage && inlineMessage.length > 0 ? inlineMessage : undefined,
        { ...options, amend: true, edit: !inlineMessage || inlineMessage.length === 0 },
        queuedSignal,
      );
    }, signal);
  }

  /**
   * Creates an explicitly empty commit using a required inline message.
   */
  commitEmpty(
    message: string,
    options: Omit<CommitCommandOptions, "allowEmpty" | "edit"> = {},
    signal?: AbortSignal,
  ): Promise<CommitResult> {
    return this.queue(async (queuedSignal) => {
      return this.commitWithinQueue(message, { ...options, allowEmpty: true }, queuedSignal);
    }, signal);
  }

  /**
   * Soft-resets HEAD to its parent so the last commit becomes staged changes.
   */
  undoLastCommit(signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      try {
        await this.run(["rev-parse", "--verify", "HEAD^"], queuedSignal);
      } catch (error) {
        if (error instanceof GitError) {
          throw new GitError("no-parent", "HEAD has no parent commit.", {
            argv: error.argv,
            stderr: error.stderr,
            stdout: error.stdout,
            cause: error,
          });
        }
        throw error;
      }

      await this.run(["reset", "--soft", "HEAD^"], queuedSignal);
    }, signal);
  }

  /**
   * Soft-resets the current branch to an arbitrary history target, preserving
   * the resulting changes in the index for the user to recommit.
   */
  resetSoft(targetSha: string, signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      await this.run(["reset", "--soft", targetSha], queuedSignal);
    }, signal);
  }

  /**
   * Checks out an existing branch, tag, or commit-ish reference.
   *
   * Resolution order:
   *   1) If the trimmed ref matches a local branch, run `git checkout <ref>`.
   *   2) If the ref is unique to one remote (`<remote>/<ref>`), run
   *      `git checkout --track <remoteRef>` instead — this auto-promotes a
   *      remote-only ref to a local tracking branch. The previous code
   *      surfaced the bare `pathspec '<ref>' did not match` error here.
   *   3) If the ref does not match locals or remotes, throw `no-such-ref`.
   *
   * Tag and commit-ish refs are not in `BranchList` and therefore fall into
   * case (3); the renderer surfaces the `no-such-ref` message and the user
   * can re-issue the request through a future "Checkout commit" flow.
   */
  checkout(ref: string, signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      const branches = await this.readBranchList(queuedSignal);
      const target = resolveCheckoutTarget(ref, branches);

      if (target.kind === "local") {
        await this.run(["checkout", target.ref], queuedSignal);
        return;
      }
      await this.run(["checkout", "--track", target.remoteRef], queuedSignal);
    }, signal);
  }

  /**
   * Checks out an immutable commit in detached-HEAD mode. This is intentionally
   * separate from branch checkout: `checkout()` runs the branch-list preflight
   * and may auto-track remote-only refs, while History actions target commits
   * and must not silently create or move local branches; the explicit
   * `--detach` also keeps short SHAs safe when they resemble branch names.
   */
  checkoutDetached(sha: string, signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      await this.run(["checkout", "--detach", sha], queuedSignal);
    }, signal);
  }

  /**
   * Creates a local branch that tracks `remoteRef` and checks it out. The
   * branch name is derived by stripping the leading `<remote>/` segment, so
   * `origin/main` produces a local `main`. Uses the explicit `--track` form
   * because the bare `git checkout <short>` auto-track behavior depends on
   * git version, single-remote presence, and `branch.autoSetupMerge` config.
   */
  checkoutTracking(remoteRef: string, signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      const trimmed = remoteRef.trim();
      if (trimmed.length === 0) {
        throw new GitError("unknown", "Tracking ref is required");
      }
      const slash = trimmed.indexOf("/");
      if (slash <= 0 || slash === trimmed.length - 1) {
        throw new GitError(
          "unknown",
          `Tracking ref must be in '<remote>/<branch>' form: ${trimmed}`,
        );
      }
      await this.run(["checkout", "--track", trimmed], queuedSignal);
    }, signal);
  }

  /**
   * Creates a branch, optionally at a start ref and optionally checking it out.
   */
  createBranch(
    name: string,
    checkoutOrOptions: boolean | branchOps.CreateBranchOptions = false,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.queue(async (queuedSignal) => {
      const options =
        typeof checkoutOrOptions === "boolean"
          ? { checkout: checkoutOrOptions }
          : checkoutOrOptions;
      await branchOps.createBranch(this.branchOpsRunner(queuedSignal), name, options);
    }, signal);
  }

  /**
   * Deletes one local branch. Force is reserved for the explicit second-step
   * confirmation after an unmerged delete failure.
   */
  deleteBranch(name: string, force = false, signal?: AbortSignal): Promise<void> {
    return this.queue(
      (queuedSignal) => branchOps.deleteBranch(this.branchOpsRunner(queuedSignal), name, force),
      signal,
    );
  }

  /**
   * Deletes one remote branch through a prompt-capable push operation.
   */
  deleteRemoteBranch(remote: string, name: string, signal?: AbortSignal): Promise<void> {
    return this.queue(
      (queuedSignal) =>
        branchOps.deleteRemoteBranch(this.branchOpsRunner(queuedSignal), remote, name),
      signal,
    );
  }

  /**
   * Renames a local branch.
   */
  renameBranch(from: string, to: string, signal?: AbortSignal): Promise<void> {
    return this.queue(
      (queuedSignal) => branchOps.renameBranch(this.branchOpsRunner(queuedSignal), from, to),
      signal,
    );
  }

  /**
   * Sets or unsets a local branch upstream.
   */
  setUpstream(branch: string, upstream: string | null, signal?: AbortSignal): Promise<void> {
    return this.queue(
      (queuedSignal) => branchOps.setUpstream(this.branchOpsRunner(queuedSignal), branch, upstream),
      signal,
    );
  }

  /**
   * Fast-forwards a branch from a remote ref and reports the before/after SHAs.
   */
  fastForwardBranch(
    branch: string,
    remote: string,
    remoteRef: string,
    signal?: AbortSignal,
  ): Promise<GitFastForwardResult> {
    return this.queue(
      (queuedSignal) =>
        branchOps.fastForwardBranch(this.branchOpsRunner(queuedSignal), branch, remote, remoteRef),
      signal,
    );
  }

  /**
   * Starts a merge workflow and returns conflicts as a normal result envelope.
   */
  merge(
    branch: string,
    mode: GitMergeMode = "default",
    signal?: AbortSignal,
  ): Promise<GitMergeResult> {
    return this.queue(
      (queuedSignal) => workflow.merge(this.workflowRunner(queuedSignal), branch, mode),
      signal,
    );
  }

  /**
   * Starts a non-interactive rebase workflow.
   */
  rebase(onto: string, signal?: AbortSignal): Promise<GitRebaseResult> {
    return this.queue(
      (queuedSignal) => workflow.rebase(this.workflowRunner(queuedSignal), onto),
      signal,
    );
  }

  /**
   * Cherry-picks one commit and surfaces conflicts as a result envelope.
   */
  cherryPick(sha: string, signal?: AbortSignal): Promise<GitCherryPickResult> {
    return this.queue(
      (queuedSignal) => workflow.cherryPick(this.workflowRunner(queuedSignal), sha),
      signal,
    );
  }

  /**
   * Aborts the active workflow operation by reading Git's marker files.
   */
  abortOp(signal?: AbortSignal): Promise<void> {
    return this.queue(
      (queuedSignal) => workflow.abortOp(this.workflowRunner(queuedSignal)),
      signal,
    );
  }

  /**
   * Continues the active workflow operation by reading Git's marker files.
   */
  continueOp(signal?: AbortSignal): Promise<GitContinueOpResult> {
    return this.queue(
      (queuedSignal) => workflow.continueOp(this.workflowRunner(queuedSignal)),
      signal,
    );
  }

  /**
   * Marks currently-conflicted paths as resolved after conflict-specific
   * validation.
   */
  markResolved(relPaths: readonly string[], signal?: AbortSignal): Promise<GitMarkResolvedResult> {
    return this.queue(
      (queuedSignal) => markConflictResolved(this.conflictRunner(queuedSignal), relPaths),
      signal,
    );
  }

  /**
   * Lists local and remote branch names with current branch metadata.
   */
  listBranches(signal?: AbortSignal): Promise<BranchList> {
    return this.queue(async (queuedSignal) => this.readBranchList(queuedSignal), signal);
  }

  /**
   * Lists local tags for ref picker and tag picker search.
   */
  listTags(signal?: AbortSignal): Promise<Tag[]> {
    return tagOps.listTags({ bin: this.binPath, cwd: this.topLevel }, signal);
  }

  /**
   * Lists tags from one selected remote without expanding local tag semantics.
   */
  listRemoteTags(remote: string, signal?: AbortSignal): Promise<RemoteTag[]> {
    return this.queue(
      (queuedSignal) => tagOps.listRemoteTags(this.tagOpsRunner(queuedSignal), remote),
      signal,
    );
  }

  /**
   * Creates a local lightweight or annotated tag.
   */
  createTag(
    name: string,
    options: tagOps.CreateTagOptions = {},
    signal?: AbortSignal,
  ): Promise<void> {
    return this.queue(
      (queuedSignal) => tagOps.createTag(this.tagOpsRunner(queuedSignal), name, options),
      signal,
    );
  }

  /**
   * Deletes one local tag.
   */
  deleteTag(name: string, signal?: AbortSignal): Promise<void> {
    return this.queue(
      (queuedSignal) => tagOps.deleteTag(this.tagOpsRunner(queuedSignal), name),
      signal,
    );
  }

  /**
   * Deletes one tag from a remote with askpass helpers enabled.
   */
  deleteRemoteTag(remote: string, name: string, signal?: AbortSignal): Promise<void> {
    return this.queue(
      (queuedSignal) => tagOps.deleteRemoteTag(this.tagOpsRunner(queuedSignal), remote, name),
      signal,
    );
  }

  /**
   * Pushes every local tag to the configured upstream remote or a named
   * remote. Tag pushes are separate from current-branch push semantics.
   */
  pushTags(remote?: string, signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      const trimmed = remote?.trim();
      const args = trimmed && trimmed.length > 0 ? ["push", trimmed, "--tags"] : ["push", "--tags"];
      await this.runWithHelpers(args, queuedSignal, { askpass: true });
    }, signal);
  }

  /**
   * Adds one configured remote using local URL-pattern validation only.
   */
  addRemote(name: string, url: string, signal?: AbortSignal): Promise<void> {
    return this.queue(
      (queuedSignal) => remoteOps.addRemote(this.remoteOpsRunner(queuedSignal), name, url),
      signal,
    );
  }

  /**
   * Removes one configured remote. If the current branch tracked that remote,
   * the next status refresh naturally reports branch.upstream=null.
   */
  removeRemote(name: string, signal?: AbortSignal): Promise<void> {
    return this.queue(
      (queuedSignal) => remoteOps.removeRemote(this.remoteOpsRunner(queuedSignal), name),
      signal,
    );
  }

  /**
   * Fetches from the configured remote or from a named remote. Unconfigured
   * remotes surface as `no-remote` via stderr classification; named remotes
   * that do not exist surface the same way ("'foo' does not appear to be a
   * git repository").
   */
  fetch(remote?: string, signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      const trimmed = remote?.trim();
      const args = trimmed && trimmed.length > 0 ? ["fetch", trimmed] : ["fetch"];
      await this.runWithHelpers(args, queuedSignal, { askpass: true });
    }, signal);
  }

  /**
   * Fetches every configured remote and prunes deleted remote refs. Explicit
   * user calls allow askpass/editor helpers; background autofetch keeps Git in
   * non-interactive mode so it never opens credential prompts off-screen.
   */
  fetchAll(options: { interactive?: boolean } = {}, signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      const args = ["fetch", "--all", "--prune"];
      if (options.interactive) {
        await this.runWithHelpers(args, queuedSignal, { askpass: true });
        return;
      }
      await this.run(args, queuedSignal);
    }, signal);
  }

  /**
   * Pulls from the current upstream and summarizes the successful result.
   * Missing remote / upstream surface as typed `no-remote` / `no-upstream`
   * via stderr classification rather than a hard preflight; the renderer
   * UI gates the Pull action on `RepoCapabilities` so users normally do not
   * reach this path with a misconfigured branch.
   */
  pull(signal?: AbortSignal): Promise<PullResult> {
    return this.queue(async (queuedSignal) => {
      const result = await this.runWithHelpers(["pull", "--no-edit"], queuedSignal, {
        askpass: true,
      });
      return parsePullResult(result);
    }, signal);
  }

  /**
   * Pushes the current branch.
   *
   *   - `force=true`   uses `--force-with-lease` for safer explicit force pushes.
   *   - `publish=true` runs `push -u <remote> <branch>` against the first
   *     configured remote so a branch without an upstream gains one in a
   *     single operation — this is the recovery path the renderer offers
   *     after a `no-upstream` error.
   *
   * Plain push (`publish=false`) lets git surface its own stderr; the
   * classifier maps `no-remote` / `no-upstream` / `push-rejected` so the
   * renderer can branch on a stable `kind` without preflight here.
   *
   * Publish keeps `assertHasHead` because the call needs `branch.current`
   * to construct argv and an unborn HEAD has no name to push.
   */
  push(force = false, publish = false, signal?: AbortSignal): Promise<PushResult> {
    return this.queue(async (queuedSignal) => {
      if (publish) {
        const status = await this.readStatus(queuedSignal);
        assertHasHead(status.branch);
        const branch = status.branch;
        if (!branch) throw new Error("unreachable: assertHasHead would have thrown");

        const remote = status.capabilities.remotes[0];
        if (!remote) {
          // No remotes configured — git would reject downstream too, but a
          // typed throw here lets the renderer render the publish prompt's
          // "no remote configured" path uniformly with the no-remote stderr
          // classification.
          throw new GitError("no-remote", "No git remote configured.", {
            hint: { kind: "add-remote" },
          });
        }

        const args = force
          ? ["push", "--force-with-lease", "-u", remote, branch.current]
          : ["push", "-u", remote, branch.current];
        const result = await this.runWithHelpers(args, queuedSignal, { askpass: true });
        return parsePushResult(result);
      }

      const result = await this.runWithHelpers(
        force ? ["push", "--force-with-lease"] : ["push"],
        queuedSignal,
        { askpass: true },
      );
      return parsePushResult(result);
    }, signal);
  }

  /**
   * Performs the primary Sync action in one queue slot: pull first, then push
   * only if pull completed. A cancelled pull returns an envelope and never
   * starts push. Typed Git pull failures return an error envelope so the
   * renderer can show the pull failure while preserving the no-push contract;
   * push failures still propagate.
   */
  sync(signal?: AbortSignal): Promise<GitSyncResult> {
    return this.queue(async (queuedSignal) => {
      try {
        await this.runWithHelpers(["pull", "--no-edit"], queuedSignal, { askpass: true });
      } catch (error) {
        if (isAbortError(error)) return { pulled: "cancelled", pushed: "skipped" };
        if (error instanceof GitError) {
          return {
            pulled: "error",
            pushed: "skipped",
            pullError: gitSyncErrorFromGitError(error),
          };
        }
        throw error;
      }

      await this.runWithHelpers(["push"], queuedSignal, { askpass: true });
      return { pulled: "ok", pushed: "ok" };
    }, signal);
  }

  /**
   * Saves current changes on the stash stack. Unborn-HEAD repos surface as
   * `no-head` via stderr classification ("You do not have the initial
   * commit yet"). The renderer disables Stash via `RepoCapabilities` so the
   * raw failure path is only reachable through racing state changes.
   */
  stash(message?: string, signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      const args = ["stash", "push"];
      if (message && message.trim().length > 0) args.push("-m", message);
      await this.run(args, queuedSignal);
    }, signal);
  }

  /**
   * Applies and drops the most recent stash entry. Empty-stack failures
   * surface as `empty-stash` via stderr classification; the renderer
   * disables Stash Pop on empty stash count via `RepoCapabilities`.
   */
  stashPop(signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      await popLatestStash({ bin: this.binPath, cwd: this.topLevel }, queuedSignal);
    }, signal);
  }

  /**
   * Lists stash entries with parsed stack index, source branch, and timestamp.
   */
  listStashes(signal?: AbortSignal) {
    return this.queue(
      (queuedSignal) => listStashes({ bin: this.binPath, cwd: this.topLevel }, queuedSignal),
      signal,
    );
  }

  /**
   * Applies one stash entry without dropping it from the stash stack.
   */
  applyStash(index: number, signal?: AbortSignal): Promise<void> {
    return this.queue(
      (queuedSignal) => applyStash({ bin: this.binPath, cwd: this.topLevel }, index, queuedSignal),
      signal,
    );
  }

  /**
   * Drops one stash entry from the stash stack.
   */
  dropStash(index: number, signal?: AbortSignal): Promise<void> {
    return this.queue(
      (queuedSignal) => dropStash({ bin: this.binPath, cwd: this.topLevel }, index, queuedSignal),
      signal,
    );
  }

  /**
   * Streams the patch for one stash entry as bounded text chunks.
   */
  async *showStash(index: number, signal?: AbortSignal) {
    return yield* this.queueStream(
      (queuedSignal) => showStash({ bin: this.binPath, cwd: this.topLevel }, index, queuedSignal),
      signal,
    );
  }

  /**
   * Stashes only the selected repository-relative paths.
   */
  stashGroup(paths: readonly string[], message?: string, signal?: AbortSignal): Promise<void> {
    return this.queue(
      (queuedSignal) =>
        stashGroup({ bin: this.binPath, cwd: this.topLevel }, paths, message, queuedSignal),
      signal,
    );
  }

  /**
   * Reads a blob from the index or a Git ref. Working-tree reads use fs handlers.
   */
  getFileContent(ref: string, relPath: string, signal?: AbortSignal): Promise<string> {
    return this.queue(async (queuedSignal) => {
      if (ref === "WORKING") {
        throw new GitError("unknown", "Working-tree content is read through the filesystem");
      }
      if (relPath.trim().length === 0) throw new GitError("unknown", "File path is required");
      const objectSpec = ref === "INDEX" ? `:${relPath}` : `${ref}:${relPath}`;
      const { stdout } = await this.run(["show", "--no-ext-diff", objectSpec], queuedSignal);
      return stdout;
    }, signal);
  }

  /**
   * Reads a HEAD blob as bounded UTF-8 text for the file context menu's
   * historical-content seam.
   */
  openFileAtHead(relPath: string, signal?: AbortSignal) {
    return this.queue(
      (queuedSignal) =>
        readAtHead({ bin: this.binPath, cwd: this.topLevel }, relPath, queuedSignal),
      signal,
    );
  }

  /**
   * Streams a Git blob through the repository queue so large-object reads do
   * not interleave with mutating Git operations.
   */
  async *getFileBlob(ref: string, relPath: string, signal?: AbortSignal) {
    return yield* this.queueStream(
      (queuedSignal) =>
        streamBlob({ bin: this.binPath, cwd: this.topLevel }, ref, relPath, queuedSignal),
      signal,
    );
  }

  /**
   * Appends one repository-relative path to `.gitignore` with idempotent
   * dedupe semantics.
   */
  addToGitignore(relPath: string, signal?: AbortSignal) {
    return this.queue(() => appendIgnoreEntry(this.topLevel, relPath), signal);
  }

  /**
   * Streams diff output in bounded chunks so IPC can apply back-pressure.
   */
  async *diff(
    spec: DiffSpec,
    signal?: AbortSignal,
  ): AsyncGenerator<DiffChunk, DiffComplete, unknown> {
    return yield* this.queueStream((queuedSignal) => this.streamDiff(spec, queuedSignal), signal);
  }

  /**
   * Streams commit log entries parsed into stable chunk objects.
   */
  async *log(args: GitLogArgs = {}, signal?: AbortSignal): AsyncGenerator<LogChunk, LogComplete> {
    return yield* this.queueStream((queuedSignal) => this.streamLog(args, queuedSignal), signal);
  }

  /**
   * Reads one commit's metadata and per-file changes for the editor commit tab.
   * Merge commit file changes use the first parent as the comparison base.
   */
  commitDetail(sha: string, signal?: AbortSignal): Promise<CommitDetail> {
    return this.queue((queuedSignal) => this.readCommitDetail(sha, queuedSignal), signal);
  }

  /**
   * Searches commits using server-side Git primitives. Hex prefixes resolve to
   * one commit detail; other text uses `git log --grep` so off-page commits
   * are discoverable.
   */
  searchCommits(query: string, limit = 50, signal?: AbortSignal): Promise<CommitSearchResult> {
    return this.queue(async (queuedSignal) => {
      const trimmed = query.trim();
      if (trimmed.length === 0) return { kind: "grep", entries: [] };

      if (/^[0-9a-f]{4,40}$/i.test(trimmed)) {
        const { stdout } = await this.resolveCommitPrefix(trimmed, queuedSignal);
        const sha = stdout.trim();
        if (!sha) throw new GitError("ref-not-found", `No commit found for '${trimmed}'.`);
        return { kind: "sha", detail: await this.readCommitDetail(sha, queuedSignal) };
      }

      return {
        kind: "grep",
        entries: await this.readLogEntries({ grep: trimmed, limit }, queuedSignal),
      };
    }, signal);
  }

  /**
   * Convenience hook used by registries and coalescers before broadcasting.
   */
  refreshStatus(signal?: AbortSignal): Promise<GitStatus> {
    return this.status(signal);
  }

  /**
   * Aborts in-flight and queued operations; later calls reject with AbortError.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.operationControllers) {
      controller.abort();
    }
  }

  /**
   * Adds one operation to the repository's serial chain.
   */
  private queue<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const operation = this.createQueuedOperation(signal);
    const task = this.queueTail.then(async () => {
      throwIfAborted(operation.controller.signal);
      return run(operation.controller.signal);
    });

    this.queueTail = task.then(noop, noop);

    return task.finally(operation.cleanup);
  }

  /**
   * Adds one streaming operation to the serial chain and holds it until return.
   */
  private async *queueStream<T, R>(
    run: (signal: AbortSignal) => AsyncGenerator<T, R, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<T, R, unknown> {
    const operation = this.createQueuedOperation(signal);
    const previous = this.queueTail;
    let release!: () => void;
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.queueTail = previous.then(
      () => completion,
      () => completion,
    );

    try {
      await previous;
      throwIfAborted(operation.controller.signal);
      return yield* run(operation.controller.signal);
    } finally {
      operation.cleanup();
      release();
    }
  }

  /**
   * Creates the per-operation controller that dispose() and caller signals abort.
   */
  private createQueuedOperation(signal?: AbortSignal): QueuedOperation {
    const controller = new AbortController();
    const abort = (): void => controller.abort();

    if (this.disposed || signal?.aborted) {
      controller.abort();
    } else {
      signal?.addEventListener("abort", abort, { once: true });
    }

    this.operationControllers.add(controller);

    return {
      controller,
      cleanup: () => {
        signal?.removeEventListener("abort", abort);
        this.operationControllers.delete(controller);
      },
    };
  }

  /**
   * Runs a buffered git command within the already-acquired queue slot.
   */
  private run(args: readonly string[], signal: AbortSignal): Promise<RunGitResult> {
    throwIfAborted(signal);
    return runGit({ bin: this.binPath, cwd: this.topLevel, args, interactive: false, signal });
  }

  /**
   * Runs a prompt-capable Git command with the helper socket environment
   * scoped to this repository's workspace id.
   */
  private runWithHelpers(
    args: readonly string[],
    signal: AbortSignal,
    helpers: BuildHelperEnvOptions,
  ): Promise<RunGitResult> {
    throwIfAborted(signal);
    return runGit({
      bin: this.binPath,
      cwd: this.topLevel,
      args,
      env: buildHelperEnv({ ...helpers, workspaceId: this.workspaceId }),
      interactive: true,
      signal,
    });
  }

  /**
   * Adapts private queue-bound runners to the branch-ops helper module.
   */
  private branchOpsRunner(signal: AbortSignal): branchOps.GitBranchOpsRunner {
    return {
      run: (args) => this.run(args, signal),
      runWithHelpers: (args, helpers) => this.runWithHelpers(args, signal, helpers),
      listBranches: () => this.readBranchList(signal),
    };
  }

  /**
   * Adapts private queue-bound runners to the remote helper module.
   */
  private remoteOpsRunner(signal: AbortSignal): remoteOps.GitRemoteRunner {
    return {
      run: (args) => this.run(args, signal),
    };
  }

  /**
   * Adapts private queue-bound runners to the tag helper module.
   */
  private tagOpsRunner(signal: AbortSignal): tagOps.GitTagMutationRunner {
    return {
      run: (args) => this.run(args, signal),
      runWithHelpers: (args, helpers) => this.runWithHelpers(args, signal, helpers),
    };
  }

  /**
   * Adapts private queue-bound runners to the workflow helper module.
   */
  private workflowRunner(signal: AbortSignal): workflow.GitWorkflowRunner {
    return {
      run: (args) => this.run(args, signal),
      readStatus: () => this.readStatus(signal),
      readOperationState: async () => {
        const status = await this.readStatus(signal);
        return status.operationState;
      },
    };
  }

  /**
   * Adapts private queue-bound runners to the conflict helper module.
   */
  private conflictRunner(signal: AbortSignal): GitConflictRunner {
    return {
      topLevel: this.topLevel,
      run: (args) => this.run(args, signal),
      readStatus: () => this.readStatus(signal),
    };
  }

  /**
   * Runs one commit-family command while the caller already owns the queue.
   * Inline messages use non-interactive `git commit -m`; editor-backed amend
   * uses the helper environment so Git can open the renderer commit dialog.
   */
  private async commitWithinQueue(
    message: string | undefined,
    options: CommitCommandOptions,
    signal: AbortSignal,
  ): Promise<CommitResult> {
    const args = buildCommitArgs(message, options);
    const needsEditor = options.edit === true && message === undefined;

    if (needsEditor) {
      await this.runWithHelpers(args, signal, { editor: true });
    } else {
      await this.run(args, signal);
    }

    const { stdout } = await this.run(["rev-parse", "HEAD"], signal);
    return { sha: stdout.trim() };
  }

  /**
   * Parses `git status --porcelain=v2 -z -b` output for this repository and
   * enriches it with the repo-level capability flags the renderer uses to
   * gate Source Control panel actions.
   *
   * The two extra git calls (`remote`, `stash list`) are cheap (sub-ms even
   * on large repos) and broadcast through the same `statusChanged` event,
   * so the renderer never disagrees about Push/Stash/Stash-Pop enablement
   * after a refresh.
   */
  private async readStatus(signal: AbortSignal): Promise<GitStatus> {
    const { stdout } = await this.run(
      ["status", "--porcelain=v2", "-z", "-b", "--untracked-files=all", "--renames"],
      signal,
    );
    const status = parseV2Porcelain(stdout);
    const [remotes, stashCount, tagCount, operationState, lastFetchedAt] = await Promise.all([
      this.readRemotes(signal),
      this.readStashCount(signal),
      this.readTagCount(signal),
      readGitOperationState(this.gitDir, { conflictCount: status.merge.length }),
      readFetchHeadMtime(this.gitDir),
    ]);
    const capabilities: RepoCapabilities = {
      hasHEAD: status.branch !== null && !status.branch.isUnborn,
      remotes,
      stashCount,
      tagCount,
    };
    return { ...status, capabilities, operationState, lastFetchedAt };
  }

  /**
   * Lists configured remote names (one per line). Empty stdout (no remotes
   * configured) maps to an empty array.
   */
  private async readRemotes(signal: AbortSignal): Promise<string[]> {
    const { stdout } = await this.run(["remote"], signal);
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /**
   * Counts stash entries by listing the stash log and counting non-empty
   * lines. Returns 0 when the stash is empty (`git stash list` exits
   * cleanly with no output) or when stash storage does not exist yet.
   */
  private async readStashCount(signal: AbortSignal): Promise<number> {
    const { stdout } = await this.run(["stash", "list"], signal);
    return stdout.split(/\r?\n/).filter((line) => line.length > 0).length;
  }

  /**
   * Counts local tags so menus can avoid opening an empty tag picker later.
   */
  private async readTagCount(signal: AbortSignal): Promise<number> {
    const { stdout } = await this.run(["tag", "--list"], signal);
    return stdout.split(/\r?\n/).filter((line) => line.length > 0).length;
  }

  /**
   * Snapshots local + remote branch names so checkout preflight can route a
   * bare ref to either `git checkout <local>` or `git checkout --track
   * <remote>/<ref>` without an extra round-trip.
   */
  private async readBranchList(signal: AbortSignal): Promise<BranchList> {
    const status = await this.readStatus(signal);
    const local = await this.run(["branch", "--format=%(refname:short)", "--list"], signal);
    const remote = await this.run(["branch", "--format=%(refname:short)", "--remotes"], signal);
    return {
      current: status.branch,
      local: parseBranchLines(local.stdout),
      remote: parseBranchLines(remote.stdout).filter((name) => !name.endsWith("/HEAD")),
    };
  }

  /**
   * Converts git diff stdout into fixed-size text chunks.
   */
  private async *streamDiff(
    spec: DiffSpec,
    signal: AbortSignal,
  ): AsyncGenerator<DiffChunk, DiffComplete, unknown> {
    return yield* streamGitTextChunks({
      bin: this.binPath,
      cwd: this.topLevel,
      args: buildDiffArgs(spec),
      signal,
    });
  }

  /**
   * Converts git log stdout into typed log-entry chunks. Non-ref cursor pages
   * seek inside the streamed top-of-scope traversal because `git log --all
   * <sha>^@` can re-emit already-loaded branch tips.
   */
  private async *streamLog(
    logArgs: GitLogArgs,
    signal: AbortSignal,
  ): AsyncGenerator<LogChunk, LogComplete> {
    const args = buildLogArgs(logArgs);
    const scope = logArgs.scope ?? "ref";
    const hasSource = scope !== "ref";
    const cursorSha = hasSource ? logArgs.afterSha?.trim() : undefined;
    const decoder = new StringDecoder("utf8");
    let pendingText = "";
    let count = 0;
    let hasMore = false;
    let cursorReached = !cursorSha;
    let stopReading = false;
    let entries: LogEntry[] = [];
    const limit = logArgs.limit;

    const emitReadyEntries = function* (): Generator<LogChunk> {
      if (entries.length === 0) return;
      yield { entries };
      entries = [];
    };

    const handleRecord = function* (record: string): Generator<LogChunk> {
      const entry = parseLogRecord(record, { hasSource });
      if (!entry) return;

      if (!cursorReached) {
        cursorReached = entry.sha === cursorSha;
        return;
      }

      if (limit !== undefined && count >= limit) {
        hasMore = true;
        stopReading = true;
        return;
      }

      entries.push(entry);
      count += 1;
      if (entries.length >= LOG_CHUNK_ENTRY_COUNT) {
        yield* emitReadyEntries();
      }
    };

    for await (const chunk of streamGit({ bin: this.binPath, cwd: this.topLevel, args, signal })) {
      pendingText += decoder.write(chunk);
      const records = pendingText.split(LOG_RECORD_SEPARATOR);
      pendingText = records.pop() ?? "";
      for (const record of records) {
        yield* handleRecord(record);
        if (stopReading) break;
      }
      if (stopReading) break;
    }

    pendingText += stopReading ? "" : decoder.end();
    if (!stopReading && pendingText.length > 0) {
      yield* handleRecord(pendingText);
    }
    yield* emitReadyEntries();

    return { count, hasMore };
  }

  /**
   * Reads and parses a single commit detail while the queue slot is already
   * held by the public caller.
   */
  private async readCommitDetail(sha: string, signal: AbortSignal): Promise<CommitDetail> {
    const { stdout } = await this.run(buildCommitDetailArgs(sha), signal);
    return parseCommitDetailOutput(stdout);
  }

  /**
   * Resolves a user-typed SHA prefix into one commit SHA, normalizing Git's
   * varied "unknown revision" failures into the History search contract.
   */
  private async resolveCommitPrefix(shaPrefix: string, signal: AbortSignal): Promise<RunGitResult> {
    try {
      return await this.run(["rev-parse", "--verify", `${shaPrefix}^{commit}`], signal);
    } catch (error) {
      if (error instanceof GitError) {
        throw new GitError("ref-not-found", `No commit found for '${shaPrefix}'.`, {
          argv: error.argv,
          stderr: error.stderr,
          stdout: error.stdout,
          cause: error,
        });
      }
      throw error;
    }
  }

  /**
   * Collects a bounded log stream into an array for non-streaming callers such
   * as commit search. The underlying parser and limit behavior stay shared
   * with `git.stream.log`.
   */
  private async readLogEntries(logArgs: GitLogArgs, signal: AbortSignal): Promise<LogEntry[]> {
    const entries: LogEntry[] = [];
    for await (const chunk of this.streamLog(logArgs, signal)) {
      entries.push(...chunk.entries);
    }
    return entries;
  }
}
