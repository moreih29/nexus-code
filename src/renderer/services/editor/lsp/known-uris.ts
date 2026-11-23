const knownModelUris = new Set<string>();

export function registerKnownModelUri(uri: string): void {
  knownModelUris.add(uri);
}

export function unregisterKnownModelUri(uri: string): void {
  knownModelUris.delete(uri);
}

export function isKnownModelUri(uri: string): boolean {
  return knownModelUris.has(uri);
}
