import { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface Fold<T extends HTMLElement> {
  readonly ref: RefObject<T | null>;
  readonly style: CSSProperties | undefined;
  readonly foldable: boolean;
  readonly open: boolean;
  readonly toggle: () => void;
}

export function useFold<T extends HTMLElement>(text: string, lines: number): Fold<T> {
  const ref = useRef<T>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const open = opened === text;
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again when the text changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setOver(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
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

export function FoldToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="rounded-(--radius-control) text-app-micro text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      {open ? t("agentList.detail.answer_less") : t("agentList.detail.answer_more")}
    </button>
  );
}
