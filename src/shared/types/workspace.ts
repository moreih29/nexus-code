import { z } from "zod";
import { ColorToneSchema } from "./color-tone";
import { TabMetaSchema } from "./tab";

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

export const WorkspaceLocationSchema = z.union([
  WorkspaceLocalLocationSchema,
  WorkspaceSshLocationSchema,
]);

export type WorkspaceLocation = z.infer<typeof WorkspaceLocationSchema>;

export const WorkspaceConnectionEventStatusSchema = z.enum([
  "connecting",
  "connected",
  "reconnecting",
  "error",
  "disconnected",
]);

export const WorkspaceConnectionChangedEventSchema = z.object({
  workspaceId: z.string().uuid(),
  status: WorkspaceConnectionEventStatusSchema,
});

export type WorkspaceConnectionEventStatus = z.infer<typeof WorkspaceConnectionEventStatusSchema>;

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
  if (location.kind === "ssh" && typeof location.remotePath === "string") {
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
     * Deprecated compatibility field. Prefer `location`; for SSH workspaces
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
  }),
);

export type WorkspaceMeta = z.infer<typeof WorkspaceMetaSchema>;
