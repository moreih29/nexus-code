import type { AgentProfiles } from "../../../../shared/agent-profiles/profiles";
import type { WorkspaceLocation } from "../../../../shared/types/workspace";
import type { ListedSession } from "../sessions";

export const CODEX_CATALOG_TTL_MS = 3_000;

interface CatalogScope {
  workspaceId: string;
  cwd: string;
  location: WorkspaceLocation;
  connection: string | undefined;
  config: AgentProfiles;
}

type ThreadList = Omit<ListedSession, "profileId">[];

interface CatalogEntry {
  promise: Promise<ThreadList>;
  expiresAt?: number;
}

interface WorkspaceCatalog {
  scope: CatalogScope;
  host: string;
  profiles: Map<string, CatalogEntry>;
}

const catalogs = new Map<string, WorkspaceCatalog>();

export function invalidateCodexHistory(workspaceId: string): void {
  catalogs.delete(workspaceId);
}

export function readCodexHistoryCatalog(
  scope: CatalogScope,
  profileId: string,
  fresh: boolean,
  load: () => Promise<ThreadList>,
): Promise<ThreadList> {
  const { workspaceId, cwd, location, config, connection } = scope;
  const host = JSON.stringify(location);
  let catalog = catalogs.get(workspaceId);
  if (
    !catalog ||
    catalog.scope.cwd !== cwd ||
    catalog.host !== host ||
    catalog.scope.config !== config ||
    catalog.scope.connection !== connection
  ) {
    catalog = { scope, host, profiles: new Map() };
    catalogs.set(workspaceId, catalog);
  }

  const profiles = catalog.profiles;
  const saved = profiles.get(profileId);
  if (saved && (saved.expiresAt === undefined || (!fresh && saved.expiresAt > Date.now()))) {
    return saved.promise;
  }

  const entry: CatalogEntry = { promise: Promise.resolve().then(load) };
  profiles.set(profileId, entry);
  const forget = () => {
    if (profiles.get(profileId) !== entry) return;
    profiles.delete(profileId);
    if (profiles.size === 0 && catalogs.get(workspaceId)?.profiles === profiles) {
      catalogs.delete(workspaceId);
    }
  };
  void entry.promise.then(() => {
    if (catalogs.get(workspaceId)?.profiles !== profiles || profiles.get(profileId) !== entry)
      return;
    entry.expiresAt = Date.now() + CODEX_CATALOG_TTL_MS;
    setTimeout(forget, CODEX_CATALOG_TTL_MS);
  }, forget);
  return entry.promise;
}
