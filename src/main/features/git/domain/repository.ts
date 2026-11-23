import { isAllowedGitRemoteUrl } from "../../../../shared/git/remote-validation";
import type {
  BranchList,
  CommitDetail,
  CommitResult,
  CommitSearchResult,
  DiffChunk,
  DiffComplete,
  DiffSpec,
  GitChangeStats,
  GitCherryPickResult,
  GitContinueOpResult,
  GitExpandedGroupKey,
  GitFastForwardResult,
  GitIgnoreAppendResult,
  GitLogScope,
  GitMarkResolvedResult,
  GitMergeMode,
  GitMergeResult,
  GitOpenFileAtHeadResult,
  GitRebaseResult,
  GitStatus,
  GitSyncResult,
  LogChunk,
  LogComplete,
  LogEntry,
  PullResult,
  PushResult,
  RemoteTag,
  Tag,
} from "../../../../shared/git/types";
import type {
  GitBranchCreateOptions,
  GitBranchDeleteOptions,
  GitBranchDeleteRemoteOptions,
  GitBranchFastForwardOptions,
  GitBranchRenameOptions,
  GitBranchSetUpstreamOptions,
  GitExecutor,
  RunGitResult,
} from "../bridge/types";
import { readHeadBlobAsText } from "./blob-text-decode";
import { GitError } from "./error";
import { type BuildHelperEnvOptions, buildHelperEnv } from "./helpers/launcher";
import {
  assertHasHead,
  buildCommitArgs,
  collectDiscardPathsets,
  gitSyncErrorFromGitError,
  isAbortError,
  noop,
  parseBranchLines,
  resolveCheckoutTarget,
  throwIfAborted,
} from "./repository-helpers";

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

export interface CreateBranchOptions {
  readonly checkout?: boolean;
  readonly startRef?: string;
}

export interface DiscardPathsets {
  readonly restoreAllPaths: string[];
  readonly restoreWorktreePaths: string[];
  readonly resetIndexPaths: string[];
  readonly resetThenCleanPaths: string[];
  readonly cleanPaths: string[];
}

export interface GitMetadataReader {
  metadata(
    gitDir: string,
    conflictCount: number,
    signal?: AbortSignal,
  ): Promise<{
    readonly operationState: GitStatus["operationState"];
    readonly lastFetchedAt: number | null;
  }>;
  addToGitignore(
    repoRoot: string,
    relPath: string,
    signal?: AbortSignal,
  ): Promise<GitIgnoreAppendResult>;
}

export class GitRepository {
  readonly workspaceId: string;
  readonly topLevel: string;
  readonly gitDir: string;
  readonly gitVersion: string | null;

  private readonly binPath: string;
  private readonly operationControllers = new Set<AbortController>();
  private queueTail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    workspaceId: string,
    topLevel: string,
    gitDir: string,
    bin: { readonly path: string; readonly version?: string | null } | string | null,
    private readonly executor: GitExecutor,
    private readonly metadataReader: GitMetadataReader,
  ) {
    this.workspaceId = workspaceId;
    this.topLevel = topLevel;
    this.gitDir = gitDir;
    this.binPath = typeof bin === "string" ? bin : (bin?.path ?? "git");
    this.gitVersion = typeof bin === "string" ? null : (bin?.version ?? null);
  }

  status(signal?: AbortSignal): Promise<GitStatus> {
    return this.queue((queuedSignal) => this.readStatus(queuedSignal), signal);
  }

  stage(relPaths: readonly string[], signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      if (relPaths.length === 0) return;
      await this.runForPaths(["add"], relPaths, queuedSignal);
    }, signal);
  }

  unstage(relPaths: readonly string[], signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      if (relPaths.length === 0) return;
      await this.runForPaths(["reset", "-q"], relPaths, queuedSignal);
    }, signal);
  }

  stageContent(relPath: string, content: string, signal?: AbortSignal): Promise<void> {
    return this.queue((queuedSignal) => {
      const stageContent = this.executor.stageContent;
      if (!stageContent) throw missingExecutorMethodError("stageContent");
      return stageContent.call(this.executor, {
        cwd: this.topLevel,
        relPath,
        content,
        signal: queuedSignal,
      });
    }, signal);
  }

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
        await this.runForPaths(["reset", "-q"], pathsets.resetIndexPaths, queuedSignal);
      }
      if (pathsets.restoreWorktreePaths.length > 0) {
        await this.runForPaths(
          ["restore", "--worktree"],
          pathsets.restoreWorktreePaths,
          queuedSignal,
        );
      }
      if (pathsets.restoreAllPaths.length > 0) {
        await this.runForPaths(
          ["restore", "--staged", "--worktree"],
          pathsets.restoreAllPaths,
          queuedSignal,
        );
      }
      if (pathsets.resetThenCleanPaths.length > 0) {
        await this.runForPaths(["reset", "-q"], pathsets.resetThenCleanPaths, queuedSignal);
        await this.runForPaths(["clean", "-f"], pathsets.resetThenCleanPaths, queuedSignal);
      }
      if (pathsets.cleanPaths.length > 0) {
        await this.runForPaths(["clean", "-f"], pathsets.cleanPaths, queuedSignal);
      }
    }, signal);
  }

  commit(
    message: string,
    options: CommitCommandOptions = {},
    signal?: AbortSignal,
  ): Promise<CommitResult> {
    return this.queue(async (queuedSignal) => {
      return this.commitWithinQueue(message, options, queuedSignal);
    }, signal);
  }

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

  commitEmpty(
    message: string,
    options: Omit<CommitCommandOptions, "allowEmpty" | "edit"> = {},
    signal?: AbortSignal,
  ): Promise<CommitResult> {
    return this.queue(async (queuedSignal) => {
      return this.commitWithinQueue(message, { ...options, allowEmpty: true }, queuedSignal);
    }, signal);
  }

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

  resetSoft(targetSha: string, signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      await this.run(["reset", "--soft", targetSha], queuedSignal);
    }, signal);
  }

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

  checkoutDetached(sha: string, signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      await this.run(["checkout", "--detach", sha], queuedSignal);
    }, signal);
  }

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

  createBranch(
    name: string,
    checkoutOrOptions: boolean | CreateBranchOptions = false,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.queue((queuedSignal) => {
      const opts =
        typeof checkoutOrOptions === "boolean"
          ? { checkout: checkoutOrOptions }
          : checkoutOrOptions;
      const branchCreate = this.executor.branchCreate;
      if (!branchCreate) throw missingExecutorMethodError("branchCreate");
      return branchCreate.call(this.executor, {
        cwd: this.topLevel,
        name,
        checkout: opts.checkout,
        startRef: opts.startRef,
        signal: queuedSignal,
      } satisfies GitBranchCreateOptions);
    }, signal);
  }

  deleteBranch(name: string, force = false, signal?: AbortSignal): Promise<void> {
    return this.queue((queuedSignal) => {
      const branchDelete = this.executor.branchDelete;
      if (!branchDelete) throw missingExecutorMethodError("branchDelete");
      return branchDelete.call(this.executor, {
        cwd: this.topLevel,
        name,
        force,
        signal: queuedSignal,
      } satisfies GitBranchDeleteOptions);
    }, signal);
  }

  deleteRemoteBranch(remote: string, name: string, signal?: AbortSignal): Promise<void> {
    return this.queue((queuedSignal) => {
      const branchDeleteRemote = this.executor.branchDeleteRemote;
      if (!branchDeleteRemote) throw missingExecutorMethodError("branchDeleteRemote");
      return branchDeleteRemote.call(this.executor, {
        cwd: this.topLevel,
        remote,
        name,
        signal: queuedSignal,
      } satisfies GitBranchDeleteRemoteOptions);
    }, signal);
  }

  renameBranch(from: string, to: string, signal?: AbortSignal): Promise<void> {
    return this.queue((queuedSignal) => {
      const branchRename = this.executor.branchRename;
      if (!branchRename) throw missingExecutorMethodError("branchRename");
      return branchRename.call(this.executor, {
        cwd: this.topLevel,
        from,
        to,
        signal: queuedSignal,
      } satisfies GitBranchRenameOptions);
    }, signal);
  }

  setUpstream(branch: string, upstream: string | null, signal?: AbortSignal): Promise<void> {
    return this.queue((queuedSignal) => {
      const branchSetUpstream = this.executor.branchSetUpstream;
      if (!branchSetUpstream) throw missingExecutorMethodError("branchSetUpstream");
      return branchSetUpstream.call(this.executor, {
        cwd: this.topLevel,
        branch,
        upstream,
        signal: queuedSignal,
      } satisfies GitBranchSetUpstreamOptions);
    }, signal);
  }

  fastForwardBranch(
    branch: string,
    remote: string,
    remoteRef: string,
    signal?: AbortSignal,
  ): Promise<GitFastForwardResult> {
    return this.queue((queuedSignal) => {
      const branchFastForward = this.executor.branchFastForward;
      if (!branchFastForward) throw missingExecutorMethodError("branchFastForward");
      return branchFastForward.call(this.executor, {
        cwd: this.topLevel,
        branch,
        remote,
        remoteRef,
        signal: queuedSignal,
      } satisfies GitBranchFastForwardOptions);
    }, signal);
  }

  merge(
    branch: string,
    mode: GitMergeMode = "default",
    signal?: AbortSignal,
  ): Promise<GitMergeResult> {
    return this.queue((queuedSignal) => {
      const workflowMerge = this.executor.workflowMerge;
      if (!workflowMerge) throw missingExecutorMethodError("workflowMerge");
      return workflowMerge.call(this.executor, {
        cwd: this.topLevel,
        branch,
        mode,
        signal: queuedSignal,
      });
    }, signal);
  }

  rebase(onto: string, signal?: AbortSignal): Promise<GitRebaseResult> {
    return this.queue((queuedSignal) => {
      const workflowRebase = this.executor.workflowRebase;
      if (!workflowRebase) throw missingExecutorMethodError("workflowRebase");
      return workflowRebase.call(this.executor, { cwd: this.topLevel, onto, signal: queuedSignal });
    }, signal);
  }

  cherryPick(sha: string, signal?: AbortSignal): Promise<GitCherryPickResult> {
    return this.queue((queuedSignal) => {
      const workflowCherryPick = this.executor.workflowCherryPick;
      if (!workflowCherryPick) throw missingExecutorMethodError("workflowCherryPick");
      return workflowCherryPick.call(this.executor, {
        cwd: this.topLevel,
        sha,
        signal: queuedSignal,
      });
    }, signal);
  }

  abortOp(signal?: AbortSignal): Promise<void> {
    return this.queue((queuedSignal) => {
      const workflowAbort = this.executor.workflowAbort;
      if (!workflowAbort) throw missingExecutorMethodError("workflowAbort");
      return workflowAbort.call(this.executor, { cwd: this.topLevel, signal: queuedSignal });
    }, signal);
  }

  continueOp(signal?: AbortSignal): Promise<GitContinueOpResult> {
    return this.queue((queuedSignal) => {
      const workflowContinue = this.executor.workflowContinue;
      if (!workflowContinue) throw missingExecutorMethodError("workflowContinue");
      return workflowContinue.call(this.executor, { cwd: this.topLevel, signal: queuedSignal });
    }, signal);
  }

  markResolved(relPaths: readonly string[], signal?: AbortSignal): Promise<GitMarkResolvedResult> {
    return this.queue((queuedSignal) => {
      const conflictMarkResolved = this.executor.conflictMarkResolved;
      if (!conflictMarkResolved) throw missingExecutorMethodError("conflictMarkResolved");
      return conflictMarkResolved.call(this.executor, {
        cwd: this.topLevel,
        relPaths,
        signal: queuedSignal,
      });
    }, signal);
  }

  addWorktree(
    worktreePath: string,
    branch: string,
    base = "HEAD",
    signal?: AbortSignal,
  ): Promise<void> {
    return this.queue(async (queuedSignal) => {
      await this.run(["worktree", "add", "-b", branch, "--", worktreePath, base], queuedSignal);
    }, signal);
  }

  worktreeHasChanges(worktreePath: string, signal?: AbortSignal): Promise<boolean> {
    return this.queue(async (queuedSignal) => {
      const { stdout } = await this.run(
        ["-C", worktreePath, "status", "--porcelain", "--untracked-files=normal"],
        queuedSignal,
      );
      return stdout.trim() !== "";
    }, signal);
  }

  worktreeBranch(worktreePath: string, signal?: AbortSignal): Promise<string | null> {
    return this.queue(async (queuedSignal) => {
      try {
        const { stdout } = await this.run(
          ["-C", worktreePath, "symbolic-ref", "--quiet", "--short", "HEAD"],
          queuedSignal,
        );
        return stdout.trim() || null;
      } catch (error) {
        if (error instanceof GitError) return null;
        throw error;
      }
    }, signal);
  }

  hasBranch(name: string, signal?: AbortSignal): Promise<boolean> {
    return this.queue(async (queuedSignal) => {
      try {
        await this.run(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], queuedSignal);
        return true;
      } catch (error) {
        if (error instanceof GitError) return false;
        throw error;
      }
    }, signal);
  }

  branchRenamedFrom(name: string, from: string, signal?: AbortSignal): Promise<boolean> {
    return this.queue(async (queuedSignal) => {
      try {
        const { stdout } = await this.run(
          ["reflog", "show", "--format=%gs", `refs/heads/${name}`, "--"],
          queuedSignal,
        );
        const renamed = `Branch: renamed refs/heads/${from} to refs/heads/`;
        return stdout.split("\n").some((line) => line.startsWith(renamed));
      } catch (error) {
        if (error instanceof GitError) return false;
        throw error;
      }
    }, signal);
  }

  pruneWorktrees(signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      await this.run(["worktree", "prune"], queuedSignal);
    }, signal);
  }

  removeWorktree(worktreePath: string, force = false, signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      await this.run(
        ["worktree", "remove", ...(force ? ["--force"] : []), "--", worktreePath],
        queuedSignal,
      );
    }, signal);
  }

  listBranches(signal?: AbortSignal): Promise<BranchList> {
    return this.queue(async (queuedSignal) => this.readBranchList(queuedSignal), signal);
  }

  listTags(signal?: AbortSignal): Promise<Tag[]> {
    return this.queue((queuedSignal) => {
      const tagList = this.executor.tagList;
      if (!tagList) throw missingExecutorMethodError("tagList");
      return tagList.call(this.executor, { cwd: this.topLevel, signal: queuedSignal });
    }, signal);
  }

  listRemoteTags(remote: string, signal?: AbortSignal): Promise<RemoteTag[]> {
    return this.queue((queuedSignal) => {
      const tagListRemote = this.executor.tagListRemote;
      if (!tagListRemote) throw missingExecutorMethodError("tagListRemote");
      return tagListRemote.call(this.executor, {
        cwd: this.topLevel,
        remote,
        signal: queuedSignal,
      });
    }, signal);
  }

  createTag(
    name: string,
    options: { readonly ref?: string; readonly message?: string } = {},
    signal?: AbortSignal,
  ): Promise<void> {
    return this.queue((queuedSignal) => {
      const tagCreate = this.executor.tagCreate;
      if (!tagCreate) throw missingExecutorMethodError("tagCreate");
      return tagCreate.call(this.executor, {
        cwd: this.topLevel,
        name,
        ref: options.ref,
        message: options.message,
        signal: queuedSignal,
      });
    }, signal);
  }

  deleteTag(name: string, signal?: AbortSignal): Promise<void> {
    return this.queue((queuedSignal) => {
      const tagDelete = this.executor.tagDelete;
      if (!tagDelete) throw missingExecutorMethodError("tagDelete");
      return tagDelete.call(this.executor, { cwd: this.topLevel, name, signal: queuedSignal });
    }, signal);
  }

  deleteRemoteTag(remote: string, name: string, signal?: AbortSignal): Promise<void> {
    return this.queue((queuedSignal) => {
      const tagDeleteRemote = this.executor.tagDeleteRemote;
      if (!tagDeleteRemote) throw missingExecutorMethodError("tagDeleteRemote");
      return tagDeleteRemote.call(this.executor, {
        cwd: this.topLevel,
        remote,
        name,
        signal: queuedSignal,
      });
    }, signal);
  }

  pushTags(remote?: string, signal?: AbortSignal): Promise<void> {
    return this.queue((queuedSignal) => {
      const tagPush = this.executor.tagPush;
      if (!tagPush) throw missingExecutorMethodError("tagPush");
      return tagPush.call(this.executor, {
        cwd: this.topLevel,
        remote: remote?.trim() || undefined,
        signal: queuedSignal,
      });
    }, signal);
  }

  addRemote(name: string, url: string, signal?: AbortSignal): Promise<void> {
    if (!isAllowedGitRemoteUrl(url)) {
      return Promise.reject(
        new GitError(
          "remote-url-invalid",
          "Remote URL must start with https://, git@, ssh://, or file://.",
        ),
      );
    }
    return this.queue((queuedSignal) => {
      const remoteAdd = this.executor.remoteAdd;
      if (!remoteAdd) throw missingExecutorMethodError("remoteAdd");
      return remoteAdd.call(this.executor, {
        cwd: this.topLevel,
        name,
        url,
        signal: queuedSignal,
      });
    }, signal);
  }

  removeRemote(name: string, signal?: AbortSignal): Promise<void> {
    return this.queue((queuedSignal) => {
      const remoteRemove = this.executor.remoteRemove;
      if (!remoteRemove) throw missingExecutorMethodError("remoteRemove");
      return remoteRemove.call(this.executor, { cwd: this.topLevel, name, signal: queuedSignal });
    }, signal);
  }

  fetch(remote?: string, signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      const trimmed = remote?.trim();
      const args = trimmed && trimmed.length > 0 ? ["fetch", trimmed] : ["fetch"];
      await this.runWithHelpers(args, queuedSignal, { askpass: true });
    }, signal);
  }

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

  pull(signal?: AbortSignal): Promise<PullResult> {
    return this.queue(async (queuedSignal) => {
      const executorPull = this.executor.pull;
      if (!executorPull) throw missingExecutorMethodError("pull");
      return executorPull.call(this.executor, { cwd: this.topLevel, signal: queuedSignal });
    }, signal);
  }

  push(force = false, publish = false, signal?: AbortSignal): Promise<PushResult> {
    return this.queue(async (queuedSignal) => {
      const executorPush = this.executor.push;
      if (!executorPush) throw missingExecutorMethodError("push");

      if (publish) {
        const status = await this.readStatus(queuedSignal);
        assertHasHead(status.branch);
        const branch = status.branch;
        if (!branch) throw new Error("unreachable: assertHasHead would have thrown");

        const remote = status.capabilities.remotes[0];
        if (!remote) {
          throw new GitError("no-remote", "No git remote configured.", {
            hint: { kind: "add-remote" },
          });
        }

        const args = force
          ? ["push", "--force-with-lease", "-u", remote, branch.current]
          : ["push", "-u", remote, branch.current];
        return executorPush.call(this.executor, { cwd: this.topLevel, args, signal: queuedSignal });
      }

      return executorPush.call(this.executor, {
        cwd: this.topLevel,
        force,
        signal: queuedSignal,
      });
    }, signal);
  }

  sync(signal?: AbortSignal): Promise<GitSyncResult> {
    return this.queue(async (queuedSignal) => {
      const executorPull = this.executor.pull;
      if (!executorPull) throw missingExecutorMethodError("pull");
      const executorPush = this.executor.push;
      if (!executorPush) throw missingExecutorMethodError("push");

      try {
        await executorPull.call(this.executor, { cwd: this.topLevel, signal: queuedSignal });
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

      await executorPush.call(this.executor, { cwd: this.topLevel, signal: queuedSignal });
      return { pulled: "ok", pushed: "ok" };
    }, signal);
  }

  stash(message?: string, signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      const args = ["stash", "push"];
      if (message && message.trim().length > 0) args.push("-m", message);
      await this.run(args, queuedSignal);
    }, signal);
  }

  stashPop(signal?: AbortSignal): Promise<void> {
    return this.queue(async (queuedSignal) => {
      const stashPop = this.executor.stashPop;
      if (!stashPop) throw missingExecutorMethodError("stashPop");
      await stashPop.call(this.executor, { cwd: this.topLevel, signal: queuedSignal });
    }, signal);
  }

  listStashes(signal?: AbortSignal) {
    return this.queue((queuedSignal) => {
      const stashList = this.executor.stashList;
      if (!stashList) throw missingExecutorMethodError("stashList");
      return stashList.call(this.executor, { cwd: this.topLevel, signal: queuedSignal });
    }, signal);
  }

  applyStash(index: number, signal?: AbortSignal): Promise<void> {
    return this.queue((queuedSignal) => {
      const stashApply = this.executor.stashApply;
      if (!stashApply) throw missingExecutorMethodError("stashApply");
      return stashApply.call(this.executor, {
        cwd: this.topLevel,
        index,
        signal: queuedSignal,
      });
    }, signal);
  }

  dropStash(index: number, signal?: AbortSignal): Promise<void> {
    return this.queue((queuedSignal) => {
      const stashDrop = this.executor.stashDrop;
      if (!stashDrop) throw missingExecutorMethodError("stashDrop");
      return stashDrop.call(this.executor, {
        cwd: this.topLevel,
        index,
        signal: queuedSignal,
      });
    }, signal);
  }

  async *showStash(index: number, signal?: AbortSignal) {
    return yield* this.queueStream((queuedSignal) => {
      const stashShow = this.executor.stashShow;
      if (!stashShow) throw missingExecutorMethodError("stashShow");
      return stashShow.call(this.executor, {
        cwd: this.topLevel,
        index,
        signal: queuedSignal,
      });
    }, signal);
  }

  stashGroup(paths: readonly string[], message?: string, signal?: AbortSignal): Promise<void> {
    return this.queue((queuedSignal) => {
      const stashGroup = this.executor.stashGroup;
      if (!stashGroup) throw missingExecutorMethodError("stashGroup");
      return stashGroup.call(this.executor, {
        cwd: this.topLevel,
        paths,
        message,
        signal: queuedSignal,
      });
    }, signal);
  }

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

  openFileAtHead(relPath: string, signal?: AbortSignal): Promise<GitOpenFileAtHeadResult> {
    return this.queue((queuedSignal) => this.readHeadBlobAsText(relPath, queuedSignal), signal);
  }

  async *getFileBlob(ref: string, relPath: string, signal?: AbortSignal) {
    return yield* this.queueStream((queuedSignal) => {
      const blob = this.executor.blob;
      if (!blob) throw missingExecutorMethodError("blob");
      return blob.call(this.executor, {
        cwd: this.topLevel,
        ref,
        relPath,
        signal: queuedSignal,
      });
    }, signal);
  }

  addToGitignore(relPath: string, signal?: AbortSignal) {
    return this.queue(
      (queuedSignal) => this.metadataReader.addToGitignore(this.topLevel, relPath, queuedSignal),
      signal,
    );
  }

  async checkIgnore(relPaths: readonly string[], signal?: AbortSignal): Promise<string[]> {
    if (relPaths.length === 0) return [];
    return this.queue(async (queuedSignal) => {
      try {
        const checkedPaths = new Map(
          relPaths.map((file) => [file.startsWith(":") ? `./${file}` : file, file]),
        );
        const { stdout } = await this.run(
          ["-c", "core.quotePath=false", "check-ignore", "--", ...checkedPaths.keys()],
          queuedSignal,
        );
        return stdout
          .split("\n")
          .map((line) => line.trimEnd())
          .filter((p) => p.length > 0)
          .map((file) => checkedPaths.get(file) ?? file);
      } catch (err) {
        if (err instanceof GitError && err.exitCode === 1) return [];
        throw err;
      }
    }, signal);
  }

  async *diff(
    spec: DiffSpec,
    signal?: AbortSignal,
  ): AsyncGenerator<DiffChunk, DiffComplete, unknown> {
    return yield* this.queueStream((queuedSignal) => this.streamDiff(spec, queuedSignal), signal);
  }

  async *log(args: GitLogArgs = {}, signal?: AbortSignal): AsyncGenerator<LogChunk, LogComplete> {
    return yield* this.queueStream((queuedSignal) => this.streamLog(args, queuedSignal), signal);
  }

  commitDetail(sha: string, signal?: AbortSignal): Promise<CommitDetail> {
    return this.queue((queuedSignal) => this.readCommitDetail(sha, queuedSignal), signal);
  }

  changeStats(base: string | undefined, signal?: AbortSignal): Promise<GitChangeStats> {
    return this.queue((queuedSignal) => {
      const changeStats = this.executor.changeStats;
      if (!changeStats) throw missingExecutorMethodError("changeStats");
      return changeStats.call(this.executor, { cwd: this.topLevel, base, signal: queuedSignal });
    }, signal);
  }

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

  refreshStatus(signal?: AbortSignal): Promise<GitStatus> {
    return this.status(signal);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.operationControllers) {
      controller.abort();
    }
  }

  private queue<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const operation = this.createQueuedOperation(signal);
    const task = this.queueTail.then(async () => {
      throwIfAborted(operation.controller.signal);
      return run(operation.controller.signal);
    });

    this.queueTail = task.then(noop, noop);

    return task.finally(operation.cleanup);
  }

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

    let tornDown = false;
    const tearDown = (): void => {
      if (tornDown) return;
      tornDown = true;
      signal?.removeEventListener("abort", tearDown);
      operation.cleanup();
      release();
    };
    signal?.addEventListener("abort", tearDown, { once: true });

    try {
      await previous;
      throwIfAborted(operation.controller.signal);
      return yield* run(operation.controller.signal);
    } finally {
      tearDown();
    }
  }

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

  private run(
    args: readonly string[],
    signal: AbortSignal,
    env?: NodeJS.ProcessEnv,
  ): Promise<RunGitResult> {
    throwIfAborted(signal);
    return this.executor.run({
      bin: this.binPath,
      cwd: this.topLevel,
      args,
      ...(env ? { env } : {}),
      interactive: false,
      signal,
    });
  }

  private runForPaths(
    args: readonly string[],
    paths: readonly string[],
    signal: AbortSignal,
  ): Promise<RunGitResult> {
    return this.run([...args, "--", ...paths], signal, { GIT_LITERAL_PATHSPECS: "1" });
  }

  private runWithHelpers(
    args: readonly string[],
    signal: AbortSignal,
    helpers: BuildHelperEnvOptions,
  ): Promise<RunGitResult> {
    throwIfAborted(signal);
    return this.executor.run({
      bin: this.binPath,
      cwd: this.topLevel,
      args,
      env: buildHelperEnv({ ...helpers, workspaceId: this.workspaceId }),
      interactive: true,
      signal,
    });
  }

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

  private async readStatus(signal: AbortSignal): Promise<GitStatus> {
    const status = this.executor.status;
    if (!status) throw missingExecutorMethodError("status");
    return status.call(this.executor, {
      cwd: this.topLevel,
      untracked: "all",
      renames: true,
      signal,
    });
  }

  private async readHeadBlobAsText(
    relPath: string,
    signal: AbortSignal,
  ): Promise<GitOpenFileAtHeadResult> {
    return readHeadBlobAsText({
      executor: this.executor,
      topLevel: this.topLevel,
      relPath,
      signal,
    });
  }

  private async readBranchList(signal: AbortSignal): Promise<BranchList> {
    const status = await this.readStatus(signal);
    const local = await this.run(["branch", "--format=%(refname:short)", "--list"], signal);
    const remote = await this.run(["branch", "--format=%(refname:lstrip=2)", "--remotes"], signal);
    return {
      current: status.branch,
      local: parseBranchLines(local.stdout),
      remote: parseBranchLines(remote.stdout).filter((name) => !name.endsWith("/HEAD")),
    };
  }

  private async *streamDiff(
    spec: DiffSpec,
    signal: AbortSignal,
  ): AsyncGenerator<DiffChunk, DiffComplete, unknown> {
    const diff = this.executor.diff;
    if (!diff) throw missingExecutorMethodError("diff");
    return yield* diff.call(this.executor, {
      cwd: this.topLevel,
      spec,
      signal,
    });
  }

  private async *streamLog(
    logArgs: GitLogArgs,
    signal: AbortSignal,
  ): AsyncGenerator<LogChunk, LogComplete> {
    const log = this.executor.log;
    if (!log) throw missingExecutorMethodError("log");
    return yield* log.call(this.executor, {
      cwd: this.topLevel,
      ref: logArgs.ref,
      scope: logArgs.scope,
      afterSha: logArgs.afterSha,
      grep: logArgs.grep,
      skip: logArgs.skip,
      limit: logArgs.limit,
      signal,
    });
  }

  private async readCommitDetail(sha: string, signal: AbortSignal): Promise<CommitDetail> {
    const commitDetail = this.executor.commitDetail;
    if (!commitDetail) throw missingExecutorMethodError("commitDetail");
    return commitDetail.call(this.executor, { cwd: this.topLevel, sha, signal });
  }

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

  private async readLogEntries(logArgs: GitLogArgs, signal: AbortSignal): Promise<LogEntry[]> {
    const entries: LogEntry[] = [];
    for await (const chunk of this.streamLog(logArgs, signal)) {
      entries.push(...chunk.entries);
    }
    return entries;
  }
}

function missingExecutorMethodError(method: string): GitError {
  return new GitError("unknown", `Git ${method} executor is unavailable`);
}
