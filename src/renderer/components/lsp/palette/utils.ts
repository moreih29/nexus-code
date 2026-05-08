const FOCUSABLE_SELECTOR = [
  "button",
  "[href]",
  "input",
  "select",
  "textarea",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function trapTab(root: HTMLElement | null, backwards: boolean): void {
  if (!root) return;
  const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true",
  );
  if (focusable.length === 0) return;

  const active = document.activeElement as HTMLElement | null;
  const currentIndex = active ? focusable.indexOf(active) : -1;
  const nextIndex = backwards
    ? currentIndex <= 0
      ? focusable.length - 1
      : currentIndex - 1
    : currentIndex >= focusable.length - 1
      ? 0
      : currentIndex + 1;
  focusable[nextIndex]?.focus();
}
