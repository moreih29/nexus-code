import { z } from "zod";
import {
  IntegerSchema,
  NonnegativeIntegerSchema,
  PositiveIntegerSchema,
} from "../../../packages/remote-protocol/src/validation";
import { LspBootstrapProgressPhaseSchema } from "../lsp/diagnostics";
import { DateTimeSchema } from "../validation/string";
import { TabMetaSchema } from "./tab";
import { toWorkspaceColor, WorkspaceColorSchema } from "./workspace-color";
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
    port: PositiveIntegerSchema.check(z.lte(65_535)).optional(),
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

export const WorkspaceWslLocationSchema = z.object({
  kind: z.literal("wsl"),
  distro: z.string().min(1),
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

export const WorkspaceTaskSchema = z.object({
  parentId: z.guid(),
  branch: z.string().min(1),
  worktreePath: z.string().min(1),
  createdBy: z.object({ workspaceId: z.guid(), tabId: z.string().min(1) }).optional(),
});

export type WorkspaceTask = z.infer<typeof WorkspaceTaskSchema>;

export const WorkspaceConnectionEventStatusSchema = z.enum([
  "connecting",
  "connected",
  "reconnecting",
  "error",
  "disconnected",
  "unstable",
  "held-then-expired",
]);

export const WorkspaceConnectionChangedEventSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  status: WorkspaceConnectionEventStatusSchema,
});
export type WorkspaceConnectionChangedEvent = z.infer<typeof WorkspaceConnectionChangedEventSchema>;

export type WorkspaceConnectionEventStatus = z.infer<typeof WorkspaceConnectionEventStatusSchema>;

export const WorkspaceConnectionProgressEventSchema = z.object({
  workspaceId: z.string(),
  name: z.string(),
  phase: LspBootstrapProgressPhaseSchema,
  bytesDone: NonnegativeIntegerSchema.optional(),
  bytesTotal: NonnegativeIntegerSchema.optional(),
});

export type WorkspaceConnectionProgressEvent = z.infer<
  typeof WorkspaceConnectionProgressEventSchema
>;

export const SshBrowseProgressEventSchema = z.object({
  progressId: z.string(),
  name: z.string(),
  phase: LspBootstrapProgressPhaseSchema,
  bytesDone: NonnegativeIntegerSchema.optional(),
  bytesTotal: NonnegativeIntegerSchema.optional(),
});

export type SshBrowseProgressEvent = z.infer<typeof SshBrowseProgressEventSchema>;

export function rootPathFromLocation(location: WorkspaceLocation): string {
  return location.kind === "local" ? location.rootPath : location.remotePath;
}

function normalizeWorkspacePath(rawPath: string): string {
  const trimmed = rawPath.replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : "/";
}

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

export function locationLabel(
  location: WorkspaceLocation,
  options: { prefix?: boolean } = {},
): string | null {
  if (location.kind === "local") return null;
  const label =
    location.kind === "wsl"
      ? location.distro
      : (location.configAlias ??
        (location.user ? `${location.user}@${location.host}` : location.host));
  return options.prefix ? `${location.kind}: ${label}` : label;
}

export function attachHostOf(location: WorkspaceLocation): string {
  if (location.kind === "local") return "local";
  if (location.kind === "wsl") return `wsl:${location.distro}`;
  return `ssh:${location.user ?? ""}@${location.host}:${location.port ?? 22}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

    return {
      sortOrder: 0,
      pinnedSortOrder: 0,
      ...value,
      color: toWorkspaceColor(value.color),
      location,
      rootPath,
    };
  },
  z.object({
    id: z.guid(),
    name: z.string(),
    location: WorkspaceLocationSchema,
    rootPath: z.string(),
    color: WorkspaceColorSchema,
    pinned: z.boolean(),
    lastOpenedAt: DateTimeSchema.optional(),
    tabs: z.array(TabMetaSchema),
    sortOrder: IntegerSchema,
    pinnedSortOrder: IntegerSchema,
    task: WorkspaceTaskSchema.optional(),
  }),
);

export type WorkspaceMeta = z.infer<typeof WorkspaceMetaSchema>;
