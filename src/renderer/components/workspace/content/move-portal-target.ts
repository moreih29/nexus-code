/**
 * Moves `node` under `parent`, preserving its subtree's live state where the
 * platform allows. A plain appendChild is a remove + insert: every <iframe>
 * inside is torn down and reloaded, so an HtmlPreview restarts its document
 * (scroll back to top, scripts re-run) on every tab or workspace switch.
 * `moveBefore` (Chromium 133+) is an atomic move that keeps iframes, focus
 * and animations alive. It requires both ends to be connected to the same
 * document, so the first attach (node still detached) and anything it
 * rejects fall back to appendChild.
 */
export function movePortalTarget(parent: HTMLElement, node: HTMLElement): void {
  const movable = parent as HTMLElement & {
    moveBefore?: (node: Node, child: Node | null) => void;
  };
  if (node.isConnected && parent.isConnected && typeof movable.moveBefore === "function") {
    try {
      movable.moveBefore(node, null);
      redrawMediaControls(node);
      return;
    } catch {
      // Fall through to the classic move.
    }
  }
  parent.appendChild(node);
}

/**
 * Chromium leaves the native controls of an <audio> or <video> blank after
 * moveBefore: the audio bar comes back an empty pill and the video shows
 * none on hover, until the element is inserted again. Turning them off and
 * on draws them anew, without touching playback.
 */
function redrawMediaControls(node: HTMLElement): void {
  for (const media of node.querySelectorAll<HTMLMediaElement>("audio[controls], video[controls]")) {
    media.controls = false;
    media.controls = true;
  }
}
