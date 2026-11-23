const BLINK_MS = 500;
const HIDDEN_CLASS = "nexus-cursor-blink-off";

let blinking: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function stopBlinking(): void {
  clearTimeout(timer);
  timer = undefined;
  blinking?.classList.remove(HIDDEN_CLASS);
  blinking = null;
}

function observeBlockCursorColors(element: HTMLElement): MutationObserver | undefined {
  const themeStyle = [...element.querySelectorAll<HTMLStyleElement>(".xterm-screen > style")].find(
    (style) => style.textContent?.includes(".xterm-cursor-block:not(.xterm-cursor-blink)"),
  );
  if (!themeStyle) return undefined;
  const syncColors = () => {
    for (const rule of themeStyle.sheet?.cssRules ?? []) {
      if (
        rule instanceof CSSStyleRule &&
        rule.selectorText.endsWith(".xterm-cursor-block:not(.xterm-cursor-blink)")
      ) {
        element.style.setProperty("--nexus-terminal-cursor-color", rule.style.backgroundColor);
        element.style.setProperty("--nexus-terminal-cursor-accent", rule.style.color);
        element.classList.add("nexus-block-cursor-colors");
        return;
      }
    }
  };
  syncColors();
  const observer = new MutationObserver(syncColors);
  observer.observe(themeStyle, { childList: true });
  return observer;
}

export function installCursorBlink(element: HTMLElement, textarea: HTMLTextAreaElement) {
  const colorObserver = observeBlockCursorColors(element);
  const doc = textarea.ownerDocument;
  const win = doc.defaultView;
  const focused = () => doc.activeElement === textarea && doc.hasFocus() && !doc.hidden;
  const stop = () => {
    if (blinking === element) stopBlinking();
  };
  const tick = () => {
    if (!focused()) {
      stop();
      return;
    }
    element.classList.toggle(HIDDEN_CLASS);
    timer = setTimeout(tick, BLINK_MS);
  };
  const reset = () => {
    if (!focused()) {
      stop();
      return;
    }
    stopBlinking();
    blinking = element;
    timer = setTimeout(tick, BLINK_MS);
  };
  const onFocus = () => {
    win?.addEventListener("focus", reset);
    win?.addEventListener("blur", stop);
    doc.addEventListener("visibilitychange", reset);
    reset();
  };
  const onBlur = () => {
    win?.removeEventListener("focus", reset);
    win?.removeEventListener("blur", stop);
    doc.removeEventListener("visibilitychange", reset);
    stop();
  };
  textarea.addEventListener("focus", onFocus);
  textarea.addEventListener("blur", onBlur);
  if (doc.activeElement === textarea) onFocus();
  return {
    reset,
    dispose: () => {
      colorObserver?.disconnect();
      onBlur();
      textarea.removeEventListener("focus", onFocus);
      textarea.removeEventListener("blur", onBlur);
    },
  };
}
