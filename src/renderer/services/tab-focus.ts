export type TabFocusTarget = (wanted: () => boolean) => void;

const targets = new Map<string, TabFocusTarget>();
let pending: { tabId: string; wanted: () => boolean } | null = null;
let generation = 0;

const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "radio",
  "range",
  "color",
  "file",
  "submit",
  "reset",
]);

function isTextField(el: Element): boolean {
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") return !NON_TEXT_INPUTS.has((el as HTMLInputElement).type);
  return (el as HTMLElement).isContentEditable === true;
}

function focusedElement(): Element | null {
  return globalThis.document?.activeElement ?? null;
}

export function focusStillWanted(from: Element | null): boolean {
  const now = focusedElement();
  if (!now || now === from || now === globalThis.document?.body) return true;
  return !isTextField(now);
}

export function registerTabFocusTarget(tabId: string, focus: TabFocusTarget): () => void {
  targets.set(tabId, focus);
  if (pending?.tabId === tabId) {
    const { wanted } = pending;
    pending = null;
    requestAnimationFrame(() => {
      if (wanted()) focus(wanted);
    });
  }
  return () => {
    if (targets.get(tabId) === focus) targets.delete(tabId);
  };
}

export function requestTabFocus(tabId: string): void {
  const asked = ++generation;
  const from = focusedElement();
  const current = () => asked === generation;
  const wanted = () => current() && focusStillWanted(from);
  const focus = targets.get(tabId);
  if (!focus) {
    pending = { tabId, wanted };
    return;
  }
  pending = null;
  requestAnimationFrame(() => {
    if (current()) focus(wanted);
  });
}

export function cancelTabFocus(): void {
  generation += 1;
  pending = null;
}
