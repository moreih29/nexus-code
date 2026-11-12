import { z } from "zod";
import { LspBootstrapProgressPhaseSchema } from "../lsp/diagnostics";
import { ColorToneSchema } from "./color-tone";
import { TabMetaSchema } from "./tab";
import { WorkspaceIdSchema } from "./workspace-id";

export const WorkspaceLocalLocationSchema = z.object({
  kind: z.literal("local"),
  rootPath: z.string(),
});

export const WorkspaceSshLocationSchema = z.preprocess(
  (value) => {
    if (isRecord(value) && value.kind === "ssh" && value.authMode === undefined) {
      return { ...value, authMode: "interactive" };
    }
    return value;
  },
  z.object({
    kind: z.literal("ssh"),
    host: z.string(),
    user: z.string().optional(),
    port: z.number().int().positive().max(65_535).optional(),
    remotePath: z.string(),
    identityFile: z.string().optional(),
    configAlias: z.string().optional(),
    authMode: z.enum(["interactive", "key-only"]).optional(),
    remoteArch: z
      .object({
        os: z.enum(["linux", "darwin"]),
        arch: z.enum(["amd64", "arm64"]),
      })
      .optional(),
  }),
);

/**
 * A folder inside a WSL distribution on a Windows host. The Linux agent runs
 * in the distribution, reached through `wsl.exe`, as it runs on an SSH host.
 */
export const WorkspaceWslLocationSchema = z.object({
  kind: z.literal("wsl"),
  /** The distribution's name, as `wsl.exe -l` lists it. */
  distro: z.string().min(1),
  /** Absolute path inside the distribution. */
  remotePath: z.string(),
  remoteArch: z
    .object({
      os: z.literal("linux"),
      arch: z.enum(["amd64", "arm64"]),
    })
    .optional(),
});

export const WorkspaceLocationSchema = z.union([
  WorkspaceLocalLocationSchema,
  WorkspaceSshLocationSchema,
  WorkspaceWslLocationSchema,
]);

export type WorkspaceLocation = z.infer<typeof WorkspaceLocationSchema>;

/**
 * A task: a workspace on a git worktree of another workspace's repository,
 * with its own branch. The sidebar shows only its parent; the task is
 * switched to from inside the parent.
 */
export const WorkspaceTaskSchema = z.object({
  parentId: z.string().uuid(),
  branch: z.string().min(1),
  /** The worktree's top folder; the task opens the parent's subfolder of it. */
  worktreePath: z.string().min(1),
  /**
   * The terminal whose agent made the task with `nexus worktree new`;
   * absent for a task the user made in the app.
   */
  createdBy: z.object({ workspaceId: z.string().uuid(), tabId: z.string().min(1) }).optional(),
});

export type WorkspaceTask = z.infer<typeof WorkspaceTaskSchema>;

export const WorkspaceConnectionEventStatusSchema = z.enum([
  "connecting",
  "connected",
  "reconnecting",
  "error",
  "disconnected",
  // Transient: 1 missed heartbeat — channel still alive; workspaceIsOnline=true.
  "unstable",
  // Terminal: reconnected but daemon was replaced — held PTY sessions are gone.
  // Distinct from "error" (connect failure) so the renderer can show the
  // "session expired" empty state instead of the generic connection error.
  "held-then-expired",
]);

export const WorkspaceConnectionChangedEventSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  status: WorkspaceConnectionEventStatusSchema,
});

export type WorkspaceConnectionEventStatus = z.infer<typeof WorkspaceConnectionEventStatusSchema>;

/**
 * Progress event for the workspace SSH agent bootstrap.
 * Reuses the same phase enum as LspBootstrapProgressPhaseSchema of the LSP bootstrap.
 */
export const WorkspaceConnectionProgressEventSchema = z.object({
  workspaceId: z.string(),
  name: z.string(),
  phase: LspBootstrapProgressPhaseSchema,
  bytesDone: z.number().int().nonnegative().optional(),
  bytesTotal: z.number().int().nonnegative().optional(),
});

export type WorkspaceConnectionProgressEvent = z.infer<
  typeof WorkspaceConnectionProgressEventSchema
>;

/**
 * Progress event for the SSH browse session (add-workspace flow) bootstrap.
 *
 * Registered workspaces key progress by workspaceId, but in the "add workspace"
 * flow neither a workspaceId nor a sessionId exists until openBrowseSession finishes.
 * So progress is keyed by a progressId (a client-generated correlation id) the renderer
 * creates right before the call — the other fields reuse the same phase enum/byte progress
 * as WorkspaceConnectionProgressEvent.
 */
export const SshBrowseProgressEventSchema = z.object({
  progressId: z.string(),
  name: z.string(),
  phase: LspBootstrapProgressPhaseSchema,
  bytesDone: z.number().int().nonnegative().optional(),
  bytesTotal: z.number().int().nonnegative().optional(),
});

export type SshBrowseProgressEvent = z.infer<typeof SshBrowseProgressEventSchema>;

/**
 * Returns the path-like root used by legacy local-only callers.
 */
export function rootPathFromLocation(location: WorkspaceLocation): string {
  return location.kind === "local" ? location.rootPath : location.remotePath;
}

/**
 * Strips trailing slashes from a path so equivalent paths compare equal.
 * Pure string normalization — performs no filesystem access, so symlinks
 * and case-insensitive volumes are not resolved (best-effort by design).
 */
function normalizeWorkspacePath(rawPath: string): string {
  const trimmed = rawPath.replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : "/";
}

/**
 * Canonical identity key for a workspace location. Two workspaces whose
 * locations produce the same key refer to the same target and must not
 * coexist as separate entries — used to dedupe "open workspace" requests.
 *
 * Best-effort: an SSH `configAlias` and the host it resolves to are NOT
 * unified (they may key differently even when they reach the same server).
 */
export function workspaceLocationKey(location: WorkspaceLocation): string {
  if (location.kind === "local") {
    return `local:${normalizeWorkspacePath(location.rootPath)}`;
  }
  if (location.kind === "wsl") {
    return `wsl:${location.distro}:${normalizeWorkspacePath(location.remotePath)}`;
  }
  const user = location.user ?? "";
  const port = location.port ?? 22;
  return `ssh:${user}@${location.host}:${port}:${normalizeWorkspacePath(location.remotePath)}`;
}

/**
 * Narrows unknown JSON input to plain object records.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Derives the compatibility rootPath from a raw location-shaped value.
 */
function rootPathFromLocationInput(location: unknown): string | undefined {
  if (!isRecord(location)) {
    return undefined;
  }
  if (location.kind === "local" && typeof location.rootPath === "string") {
    return location.rootPath;
  }
  if (
    (location.kind === "ssh" || location.kind === "wsl") &&
    typeof location.remotePath === "string"
  ) {
    return location.remotePath;
  }
  return undefined;
}

export const WorkspaceMetaSchema = z.preprocess(
  (value) => {
    if (!isRecord(value)) {
      return value;
    }

    const location =
      value.location ??
      (typeof value.rootPath === "string"
        ? { kind: "local", rootPath: value.rootPath }
        : undefined);
    const rootPath = rootPathFromLocationInput(location) ?? value.rootPath;

    // Default sort-order fields to 0 so callers that pre-date this field
    // (persisted data, IPC payloads, tests) parse without validation failure.
    return {
      sortOrder: 0,
      pinnedSortOrder: 0,
      ...value,
      location,
      rootPath,
    };
  },
  z.object({
    id: z.string().uuid(),
    name: z.string(),
    location: WorkspaceLocationSchema,
    /**
     * Deprecated compatibility field. Prefer `location`; for SSH and WSL workspaces
     * this mirrors `location.remotePath`.
     */
    rootPath: z.string(),
    colorTone: ColorToneSchema,
    pinned: z.boolean(),
    lastOpenedAt: z.string().datetime().optional(),
    tabs: z.array(TabMetaSchema),
    /** Sort position within the unpinned group. 0 means "not yet positioned". */
    sortOrder: z.number().int(),
    /** Sort position within the pinned group. 0 means "not yet positioned". */
    pinnedSortOrder: z.number().int(),
    /** Set when this workspace is a task of another workspace. */
    task: WorkspaceTaskSchema.optional(),
  }),
);

export type WorkspaceMeta = z.infer<typeof WorkspaceMetaSchema>;
