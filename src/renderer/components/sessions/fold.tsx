/**
 * Long text folded to a few lines until it is opened. Whether it runs past
 * them is measured, not guessed from its length: a short line wraps many
 * times in a narrow panel. The text is always there to open, however long.
 */

import { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface Fold<T extends HTMLElement> {
  /** The element the text is in. */
  readonly ref: RefObject<T | null>;
  /** Its style: folded to the lines until opened. */
  readonly style: CSSProperties | undefined;
  /** Whether it runs past the lines, or was opened: the toggle shows. */
  readonly foldable: boolean;
  readonly open: boolean;
  readonly toggle: () => void;
}

/**
 * Folds `text` to `lines` lines; measured again as it changes or the panel's
 * width does. Other text, as the next prompt, comes folded.
 */
export function useFold<T extends HTMLElement>(text: string, lines: number): Fold<T> {
  const ref = useRef<T>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const open = opened === text;
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again when the text changes
  useLayoutEffect(() => {
    const el = ref.current;
    // Opened, it shows whole and no longer tells whether it would fold.
    if (!el || open) return;
    const measure = () => setOver(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // Held to a height, it keeps its size as what is in it grows (an image
    // that loads): that is watched too.
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [text, open]);
  return {
    ref,
    style: open
      ? undefined
      : {
          display: "-webkit-box",
          WebkitBoxOrient: "vertical",
          WebkitLineClamp: lines,
          overflow: "hidden",
        },
    foldable: open || over,
    open,
    toggle: () => setOpened(open ? null : text),
  };
}

/** Opens and folds the text again. */
export function FoldToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="rounded-(--radius-control) text-app-micro text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      {open ? t("sessions.detail.answer_less") : t("sessions.detail.answer_more")}
    </button>
  );
}
