/**
 * The side panel's toggle of each chat that has one, for the shortcut that
 * opens and closes it from the keyboard: a Claude tab of this computer by its
 * tab id, another computer's Claude session by its agent-view key. A Codex
 * chat has no panel and registers none. The shortcut acts on the chat in
 * front (commands/domains/chat-panel.ts).
 */

const toggles = new Map<string, () => void>();

/** Registers `toggle` as the way to open and close chat `key`'s panel; returns the unregister. */
export function registerPanelToggle(key: string, toggle: () => void): () => void {
  toggles.set(key, toggle);
  return () => {
    if (toggles.get(key) === toggle) toggles.delete(key);
  };
}

/** Whether chat `key` has a side panel to toggle. */
export function hasPanelToggle(key: string): boolean {
  return toggles.has(key);
}

/** Opens or closes chat `key`'s side panel; false when it has none. */
export function togglePanelOf(key: string): boolean {
  const toggle = toggles.get(key);
  if (!toggle) return false;
  toggle();
  return true;
}
