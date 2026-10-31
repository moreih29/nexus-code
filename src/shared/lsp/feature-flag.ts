/**
 * Whether LSP runs at all: the experimental `lspEnabled` setting, off by
 * default.
 *
 * Each process reads the setting once at startup — main before it wires the
 * LSP channel, the renderer when it hydrates app state — so a change takes
 * effect on the next launch. With it off, no LSP process is spawned and no
 * LSP UI is rendered.
 */
let lspFeatureEnabled = false;

export function isLspFeatureEnabled(): boolean {
  return lspFeatureEnabled;
}

export function setLspFeatureEnabled(enabled: boolean): void {
  lspFeatureEnabled = enabled;
}
