// Leaf module: tracks which model URIs are known to the LSP layer.
//
// Extracted from bridge.ts so that model/cache.ts and model/entry.ts can
// import these without depending on the full bridge module (which imports
// from model/cache, creating a cycle). bridge.ts re-imports and re-exports
// these from this module so callers that already import from bridge continue
// to work unchanged.
//
// Must NOT import from model/cache or model/bridge — this is a true leaf.

/** Set of model URIs currently registered as known to the LSP layer. */
const knownModelUris = new Set<string>();

/**
 * Register a model URI so LSP providers can recognise it. Called when a
 * Monaco model is attached and ready; both the workspace-scoped cacheUri
 * and the `file://` lspUri are registered so either form can be matched.
 */
export function registerKnownModelUri(uri: string): void {
  knownModelUris.add(uri);
}

/**
 * Remove a model URI from the known set. Called during `cleanupEntry` for
 * both the cacheUri and the lspUri of the closing entry.
 */
export function unregisterKnownModelUri(uri: string): void {
  knownModelUris.delete(uri);
}

/**
 * Returns true when `uri` (in either cacheUri or lspUri form) is currently
 * registered. Used by the diagnostics listener in bridge.ts to gate marker
 * updates to models that are actually open in the editor.
 */
export function isKnownModelUri(uri: string): boolean {
  return knownModelUris.has(uri);
}
