import { createListenerBus } from "../../../../shared/listener-bus";

let open = false;
const bus = createListenerBus();

export function openWorkspaceSymbolPalette(): void {
  if (open) return;
  open = true;
  bus.notify();
}

export function closeWorkspaceSymbolPalette(): void {
  if (!open) return;
  open = false;
  bus.notify();
}

export function isWorkspaceSymbolPaletteOpen(): boolean {
  return open;
}

export function subscribeWorkspaceSymbolPalette(listener: () => void): () => void {
  return bus.subscribe(listener);
}

export function __resetWorkspaceSymbolPaletteStateForTests(): void {
  open = false;
  bus.clear();
}
