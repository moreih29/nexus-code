export const PANE_FRAME_FOCUS_EVENT = "nexus-pane-frame-focus";

export function listenForPaneActivation(pane: HTMLElement, activate: () => void): () => void {
  const doc = pane.ownerDocument;
  const win = doc.defaultView;
  const onWindowBlur = () => {
    const active = doc.activeElement;
    if (active?.tagName === "IFRAME" && pane.contains(active)) activate();
  };
  const onFrameFocus = (event: Event) => {
    if (event.target === doc.activeElement && doc.hasFocus()) activate();
  };

  pane.addEventListener("focusin", activate);
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
