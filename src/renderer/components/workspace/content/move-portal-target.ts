export function movePortalTarget(parent: HTMLElement, node: HTMLElement): void {
  const movable = parent as HTMLElement & {
    moveBefore?: (node: Node, child: Node | null) => void;
  };
  if (node.isConnected && parent.isConnected && typeof movable.moveBefore === "function") {
    try {
      movable.moveBefore(node, null);
      redrawMediaControls(node);
      return;
    } catch {}
  }
  parent.appendChild(node);
}

function redrawMediaControls(node: HTMLElement): void {
  for (const media of node.querySelectorAll<HTMLMediaElement>("audio[controls], video[controls]")) {
    media.controls = false;
    media.controls = true;
  }
}
