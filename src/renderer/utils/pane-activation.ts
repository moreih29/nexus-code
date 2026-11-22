export const PANE_FRAME_FOCUS_EVENT = "nexus-pane-frame-focus";

/** Listen on the DOM pane because its tab content can be portaled in. */
export function listenForPaneActivation(pane: HTMLElement, activate: () => void): () => void {
  const doc = pane.ownerDocument;
  const win = doc.defaultView;
  const onWindowBlur = () => {
    const active = doc.activeElement;
    if (active?.tagName === "IFRAME" && pane.contains(active)) activate();
  };
  const onFrameFocus = (event: Event) => {
    // A preview's message can arrive after focus has already moved again.
    if (event.target === doc.activeElement && doc.hasFocus()) activate();
  };

  pane.addEventListener("focusin", activate);
  // Activate before descendants can consume the press or suppress mousedown.
  pane.addEventListener("pointerdown", activate, true);
  pane.addEventListener(PANE_FRAME_FOCUS_EVENT, onFrameFocus);
  win?.addEventListener("blur", onWindowBlur);
  return () => {
    pane.removeEventListener("focusin", activate);
    pane.removeEventListener("pointerdown", activate, true);
    pane.removeEventListener(PANE_FRAME_FOCUS_EVENT, onFrameFocus);
    win?.removeEventListener("blur", onWindowBlur);
  };
}
