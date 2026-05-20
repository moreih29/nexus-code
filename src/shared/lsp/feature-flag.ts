/**
 * Global compile-time gate for the LSP feature.
 *
 * Set to `false` during a policy review period while multi-workspace LSP
 * performance issues (hover/definition timeouts under concurrent workspace
 * activation) are being investigated.
 *
 * To re-enable: change the value to `true` and rebuild. All LSP code paths
 * are preserved — no code was removed. The flag simply short-circuits the
 * entry points so no LSP processes are spawned and no LSP UI is rendered.
 */
export const LSP_FEATURE_ENABLED = false;
