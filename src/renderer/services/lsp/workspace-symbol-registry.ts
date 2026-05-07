import type { MonacoRange } from "../../../shared/monaco-range";

export interface WorkspaceSymbolEntry {
  name: string;
  kind: number;
  tags?: readonly number[];
  containerName?: string;
  location: {
    uri: string | { toString(): string };
    range: MonacoRange;
  };
}

export interface WorkspaceSymbolProviderInput {
  workspaceId: string;
  query: string;
  signal?: AbortSignal;
}

export interface WorkspaceSymbolProvider<T extends WorkspaceSymbolEntry = WorkspaceSymbolEntry> {
  id: string;
  provideWorkspaceSymbols(input: WorkspaceSymbolProviderInput): Promise<readonly T[]>;
}

const providers = new Set<WorkspaceSymbolProvider>();

export function registerWorkspaceSymbolProvider(provider: WorkspaceSymbolProvider): () => void {
  providers.add(provider);
  return () => {
    providers.delete(provider);
  };
}

export async function searchWorkspaceSymbols(
  input: WorkspaceSymbolProviderInput,
): Promise<WorkspaceSymbolEntry[]> {
  if (input.query.trim().length < 1) return [];

  const snapshot = [...providers];
  const settled = await Promise.allSettled(
    snapshot.map((provider) => provider.provideWorkspaceSymbols(input)),
  );

  const combined: WorkspaceSymbolEntry[] = [];
  for (let i = 0; i < settled.length; i += 1) {
    const result = settled[i];
    if (result.status === "fulfilled") {
      combined.push(...result.value);
      continue;
    }
    const provider = snapshot[i];
    console.warn("[workspace-symbol-registry] provider failed", {
      providerId: provider?.id ?? "unknown",
      error: result.reason,
    });
  }

  return dedupeWorkspaceSymbols(combined);
}

export function dedupeWorkspaceSymbols<T extends WorkspaceSymbolEntry>(symbols: readonly T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];

  for (const symbol of symbols) {
    const key = workspaceSymbolDedupeKey(symbol);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(symbol);
  }

  return unique;
}

export function workspaceSymbolDedupeKey(symbol: WorkspaceSymbolEntry): string {
  const range = symbol.location.range;
  return JSON.stringify([
    symbolUriToString(symbol.location.uri),
    range.startLineNumber,
    range.startColumn,
    range.endLineNumber,
    range.endColumn,
    symbol.name,
  ]);
}

export function symbolUriToString(uri: WorkspaceSymbolEntry["location"]["uri"]): string {
  return typeof uri === "string" ? uri : uri.toString();
}

export function __resetWorkspaceSymbolRegistryForTests(): void {
  providers.clear();
}
