let open = false;
const subscribers = new Set<() => void>();

function notify(): void {
  for (const subscriber of subscribers) subscriber();
}

export function openWorkspaceSymbolPalette(): void {
  if (open) return;
  open = true;
  notify();
}

export function closeWorkspaceSymbolPalette(): void {
  if (!open) return;
  open = false;
  notify();
}

export function isWorkspaceSymbolPaletteOpen(): boolean {
  return open;
}

export function subscribeWorkspaceSymbolPalette(listener: () => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

export function __resetWorkspaceSymbolPaletteStateForTests(): void {
  open = false;
  subscribers.clear();
}
