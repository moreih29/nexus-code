const toggles = new Map<string, () => void>();

export function registerPanelToggle(key: string, toggle: () => void): () => void {
  toggles.set(key, toggle);
  return () => {
    if (toggles.get(key) === toggle) toggles.delete(key);
  };
}

export function hasPanelToggle(key: string): boolean {
  return toggles.has(key);
}

export function togglePanelOf(key: string): boolean {
  const toggle = toggles.get(key);
  if (!toggle) return false;
  toggle();
  return true;
}
