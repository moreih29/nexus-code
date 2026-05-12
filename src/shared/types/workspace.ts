import { z } from "zod";
import { ColorToneSchema } from "./color-tone";
import { TabMetaSchema } from "./tab";

export const WorkspaceLocalLocationSchema = z.object({
  kind: z.literal("local"),
  rootPath: z.string(),
});

export const WorkspaceSshLocationSchema = z.object({
  kind: z.literal("ssh"),
  host: z.string(),
  user: z.string().optional(),
  port: z.number().int().positive().max(65_535).optional(),
  remotePath: z.string(),
  identityFile: z.string().optional(),
  configAlias: z.string().optional(),
});

export const WorkspaceLocationSchema = z.discriminatedUnion("kind", [
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

    return {
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
  }),
);

export type WorkspaceMeta = z.infer<typeof WorkspaceMetaSchema>;
