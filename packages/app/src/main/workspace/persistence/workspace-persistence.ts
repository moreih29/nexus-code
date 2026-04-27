import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  LastSessionSnapshot,
  WorkspaceId,
  WorkspaceRegistry,
  WorkspaceRegistryEntry,
} from "../../../../../shared/src/contracts/workspace/workspace";

const WORKSPACE_REGISTRY_VERSION = 1;
const LAST_SESSION_SNAPSHOT_VERSION = 1;

export const WORKSPACE_REGISTRY_FILENAME = "workspace-registry.v1.json";
export const LAST_SESSION_SNAPSHOT_FILENAME = "last-session-snapshot.v1.json";

const EMPTY_REGISTRY: WorkspaceRegistry = {
  version: WORKSPACE_REGISTRY_VERSION,
  workspaces: [],
};

type JsonObject = Record<string, unknown>;

export interface WorkspacePersistenceOptions {
  storageDir: string;
  now?: () => Date;
}

export interface RestoredWorkspaceSession {
  registry: WorkspaceRegistry;
  snapshot: LastSessionSnapshot;
  openWorkspaces: WorkspaceRegistryEntry[];
  activeWorkspace: WorkspaceRegistryEntry | null;
}

export function normalizeWorkspaceAbsolutePath(inputPath: string): string {
  const trimmedPath = inputPath.trim();
  if (trimmedPath.length === 0) {
    throw new Error("Workspace path cannot be empty.");
  }

  const absolutePath = path.resolve(trimmedPath);
  const normalizedPath = path.normalize(absolutePath).normalize("NFC");
  return trimTrailingSeparators(normalizedPath);
}

export function createWorkspaceId(absolutePath: string): WorkspaceId {
  const normalizedPath = normalizeWorkspaceAbsolutePath(absolutePath);
  const digest = createHash("sha256").update(normalizedPath, "utf8").digest("hex");
  return `ws_${digest.slice(0, 16)}`;
}

export class WorkspacePersistenceStore {
  private readonly registryFilePath: string;
  private readonly sessionSnapshotFilePath: string;
  private readonly now: () => Date;

  constructor(options: WorkspacePersistenceOptions) {
    const normalizedStorageDir = options.storageDir.trim();
    if (normalizedStorageDir.length === 0) {
      throw new Error("storageDir is required.");
    }

    this.registryFilePath = path.join(normalizedStorageDir, WORKSPACE_REGISTRY_FILENAME);
    this.sessionSnapshotFilePath = path.join(
      normalizedStorageDir,
      LAST_SESSION_SNAPSHOT_FILENAME,
    );
    this.now = options.now ?? (() => new Date());
  }

  public async getWorkspaceRegistry(): Promise<WorkspaceRegistry> {
    const raw = await this.readJson(this.registryFilePath);
    return normalizeWorkspaceRegistry(raw);
  }

  public async listRegisteredWorkspaces(): Promise<WorkspaceRegistryEntry[]> {
    const registry = await this.getWorkspaceRegistry();
    return [...registry.workspaces];
  }

  public async getLastSessionSnapshot(): Promise<LastSessionSnapshot> {
    const raw = await this.readJson(this.sessionSnapshotFilePath);
    return normalizeLastSessionSnapshot(raw, this.nowIsoString());
  }

  public async registerWorkspace(
    workspacePath: string,
    displayName?: string,
  ): Promise<WorkspaceRegistryEntry> {
    const absolutePath = normalizeWorkspaceAbsolutePath(workspacePath);
    const workspaceId = createWorkspaceId(absolutePath);
    const nowIsoString = this.nowIsoString();
    const registry = await this.getWorkspaceRegistry();
    const existingIndex = registry.workspaces.findIndex((entry) => entry.id === workspaceId);
    const explicitDisplayName = normalizeDisplayName(displayName);
    const resolvedDisplayName = explicitDisplayName ?? resolveDisplayName(absolutePath);

    if (existingIndex >= 0) {
      const existingEntry = registry.workspaces[existingIndex];
      registry.workspaces[existingIndex] = {
        ...existingEntry,
        absolutePath,
        displayName: explicitDisplayName ?? existingEntry.displayName,
        lastOpenedAt: nowIsoString,
      };
    } else {
      registry.workspaces.push({
        id: workspaceId,
        absolutePath,
        displayName: resolvedDisplayName,
        createdAt: nowIsoString,
        lastOpenedAt: nowIsoString,
      });
    }

    await this.writeWorkspaceRegistry(registry);
    return registry.workspaces.find((entry) => entry.id === workspaceId)!;
  }

  public async openWorkspace(workspaceId: WorkspaceId): Promise<LastSessionSnapshot> {
    const nowIsoString = this.nowIsoString();
    const registry = await this.getWorkspaceRegistry();
    const workspaceEntry = registry.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspaceEntry) {
      throw new Error(`Workspace "${workspaceId}" is not registered.`);
    }

    workspaceEntry.lastOpenedAt = nowIsoString;
    const snapshot = await this.getLastSessionSnapshot();
    if (!snapshot.openWorkspaceIds.includes(workspaceId)) {
      snapshot.openWorkspaceIds = [...snapshot.openWorkspaceIds, workspaceId];
    }
    snapshot.activeWorkspaceId = workspaceId;
    snapshot.capturedAt = nowIsoString;

    await Promise.all([
      this.writeWorkspaceRegistry(registry),
      this.writeLastSessionSnapshot(snapshot),
    ]);
    return snapshot;
  }

  public async activateWorkspace(workspaceId: WorkspaceId): Promise<LastSessionSnapshot> {
    const snapshot = await this.getLastSessionSnapshot();
    if (!snapshot.openWorkspaceIds.includes(workspaceId)) {
      throw new Error(`Workspace "${workspaceId}" is not currently open.`);
    }

    snapshot.activeWorkspaceId = workspaceId;
    snapshot.capturedAt = this.nowIsoString();
    await this.writeLastSessionSnapshot(snapshot);
    return snapshot;
  }

  public async closeWorkspace(workspaceId: WorkspaceId): Promise<LastSessionSnapshot> {
    const snapshot = await this.getLastSessionSnapshot();
    if (!snapshot.openWorkspaceIds.includes(workspaceId)) {
      return snapshot;
    }

    snapshot.openWorkspaceIds = snapshot.openWorkspaceIds.filter((id) => id !== workspaceId);
    if (snapshot.activeWorkspaceId === workspaceId) {
      snapshot.activeWorkspaceId =
        snapshot.openWorkspaceIds[snapshot.openWorkspaceIds.length - 1] ?? null;
    }
    snapshot.capturedAt = this.nowIsoString();
    await this.writeLastSessionSnapshot(snapshot);
    return snapshot;
  }

  public async restoreWorkspaceSession(): Promise<RestoredWorkspaceSession> {
    const registry = await this.getWorkspaceRegistry();
    const snapshot = await this.getLastSessionSnapshot();
    const byWorkspaceId = new Map(registry.workspaces.map((entry) => [entry.id, entry]));
    const sanitizedOpenWorkspaceIds = sanitizeOpenWorkspaceIds(
      snapshot.openWorkspaceIds,
      byWorkspaceId,
    );

    const sanitizedActiveWorkspaceId =
      snapshot.activeWorkspaceId && sanitizedOpenWorkspaceIds.includes(snapshot.activeWorkspaceId)
        ? snapshot.activeWorkspaceId
        : sanitizedOpenWorkspaceIds[sanitizedOpenWorkspaceIds.length - 1] ?? null;

    const sanitizedSnapshot: LastSessionSnapshot = {
      version: LAST_SESSION_SNAPSHOT_VERSION,
      openWorkspaceIds: sanitizedOpenWorkspaceIds,
      activeWorkspaceId: sanitizedActiveWorkspaceId,
      capturedAt: snapshot.capturedAt,
    };

    if (!isSnapshotEqual(snapshot, sanitizedSnapshot)) {
      sanitizedSnapshot.capturedAt = this.nowIsoString();
      await this.writeLastSessionSnapshot(sanitizedSnapshot);
    }

    const openWorkspaces = sanitizedOpenWorkspaceIds
      .map((workspaceId) => byWorkspaceId.get(workspaceId))
      .filter((entry): entry is WorkspaceRegistryEntry => entry !== undefined);
    const activeWorkspace =
      sanitizedActiveWorkspaceId === null
        ? null
        : byWorkspaceId.get(sanitizedActiveWorkspaceId) ?? null;

    return {
      registry,
      snapshot: sanitizedSnapshot,
      openWorkspaces,
      activeWorkspace,
    };
  }

  private nowIsoString(): string {
    return this.now().toISOString();
  }

  private async readJson(filePath: string): Promise<unknown> {
    try {
      const rawText = await readFile(filePath, "utf8");
      return JSON.parse(rawText) as unknown;
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async writeWorkspaceRegistry(registry: WorkspaceRegistry): Promise<void> {
    await this.writeJson(this.registryFilePath, registry);
  }

  private async writeLastSessionSnapshot(snapshot: LastSessionSnapshot): Promise<void> {
    await this.writeJson(this.sessionSnapshotFilePath, snapshot);
  }

  private async writeJson(filePath: string, payload: unknown): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tempFilePath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    const serializedJson = `${JSON.stringify(payload, null, 2)}\n`;
    await writeFile(tempFilePath, serializedJson, "utf8");
    await rename(tempFilePath, filePath);
  }
}

function normalizeWorkspaceRegistry(raw: unknown): WorkspaceRegistry {
  if (!isJsonObject(raw) || raw.version !== WORKSPACE_REGISTRY_VERSION) {
    return { ...EMPTY_REGISTRY, workspaces: [] };
  }

  if (!Array.isArray(raw.workspaces)) {
    return { ...EMPTY_REGISTRY, workspaces: [] };
  }

  const seenWorkspaceIds = new Set<WorkspaceId>();
  const workspaces: WorkspaceRegistryEntry[] = [];

  for (const item of raw.workspaces) {
    if (!isJsonObject(item)) {
      continue;
    }

    if (!isNonEmptyString(item.absolutePath)) {
      continue;
    }

    const absolutePath = normalizeWorkspaceAbsolutePath(item.absolutePath);
    const workspaceId = createWorkspaceId(absolutePath);
    if (seenWorkspaceIds.has(workspaceId)) {
      continue;
    }

    const createdAt = normalizeIsoDate(item.createdAt);
    const lastOpenedAt = normalizeIsoDate(item.lastOpenedAt, createdAt);
    const explicitDisplayName = normalizeDisplayName(asOptionalString(item.displayName));
    const displayName = explicitDisplayName ?? resolveDisplayName(absolutePath);

    workspaces.push({
      id: workspaceId,
      absolutePath,
      displayName,
      createdAt,
      lastOpenedAt,
    });
    seenWorkspaceIds.add(workspaceId);
  }

  return {
    version: WORKSPACE_REGISTRY_VERSION,
    workspaces,
  };
}

function normalizeLastSessionSnapshot(
  raw: unknown,
  nowIsoString: string,
): LastSessionSnapshot {
  if (!isJsonObject(raw) || raw.version !== LAST_SESSION_SNAPSHOT_VERSION) {
    return createEmptySnapshot(nowIsoString);
  }

  const openWorkspaceIds = Array.isArray(raw.openWorkspaceIds)
    ? raw.openWorkspaceIds.filter(isNonEmptyString)
    : [];

  const activeWorkspaceId = isNonEmptyString(raw.activeWorkspaceId)
    ? raw.activeWorkspaceId
    : null;

  return {
    version: LAST_SESSION_SNAPSHOT_VERSION,
    openWorkspaceIds,
    activeWorkspaceId,
    capturedAt: normalizeIsoDate(raw.capturedAt, nowIsoString),
  };
}

function createEmptySnapshot(nowIsoString: string): LastSessionSnapshot {
  return {
    version: LAST_SESSION_SNAPSHOT_VERSION,
    openWorkspaceIds: [],
    activeWorkspaceId: null,
    capturedAt: nowIsoString,
  };
}

function sanitizeOpenWorkspaceIds(
  candidateIds: WorkspaceId[],
  byWorkspaceId: Map<WorkspaceId, WorkspaceRegistryEntry>,
): WorkspaceId[] {
  const seenWorkspaceIds = new Set<WorkspaceId>();
  const openWorkspaceIds: WorkspaceId[] = [];

  for (const workspaceId of candidateIds) {
    if (seenWorkspaceIds.has(workspaceId)) {
      continue;
    }
    if (!byWorkspaceId.has(workspaceId)) {
      continue;
    }
    seenWorkspaceIds.add(workspaceId);
    openWorkspaceIds.push(workspaceId);
  }

  return openWorkspaceIds;
}

function trimTrailingSeparators(absolutePath: string): string {
  const root = path.parse(absolutePath).root;
  if (absolutePath === root) {
    return absolutePath;
  }

  return absolutePath.replace(/[\\\/]+$/, "");
}

function resolveDisplayName(absolutePath: string): string {
  const basename = path.basename(absolutePath);
  return basename || absolutePath;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeDisplayName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizeIsoDate(candidate: unknown, fallback = new Date(0).toISOString()): string {
  if (typeof candidate !== "string") {
    return fallback;
  }

  const parsedTimestamp = Date.parse(candidate);
  if (Number.isNaN(parsedTimestamp)) {
    return fallback;
  }

  return new Date(parsedTimestamp).toISOString();
}

function isSnapshotEqual(left: LastSessionSnapshot, right: LastSessionSnapshot): boolean {
  if (left.version !== right.version) {
    return false;
  }
  if (left.activeWorkspaceId !== right.activeWorkspaceId) {
    return false;
  }
  if (left.openWorkspaceIds.length !== right.openWorkspaceIds.length) {
    return false;
  }

  return left.openWorkspaceIds.every((workspaceId, index) => {
    return workspaceId === right.openWorkspaceIds[index];
  });
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
