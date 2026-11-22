/** Listen on the DOM pane because its tab content can be portaled in. */
export function listenForPaneActivation(pane: HTMLElement, activate: () => void): () => void {
  const doc = pane.ownerDocument;
  const win = doc.defaultView;
  const onWindowBlur = () => {
    const active = doc.activeElement;
    if (active?.tagName === "IFRAME" && pane.contains(active)) activate();
  };

  pane.addEventListener("focusin", activate);
  // Activate before descendants can consume the press or suppress mousedown.
  pane.addEventListener("pointerdown", activate, true);
  win?.addEventListener("blur", onWindowBlur);
  return () => {
    pane.removeEventListener("focusin", activate);
    pane.removeEventListener("pointerdown", activate, true);
    win?.removeEventListener("blur", onWindowBlur);
  };
}
