import { Check, Copy, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { copyText, copyTextViaIpc } from "../../utils/clipboard";
import { Button } from "./button";
import { IconButton, type IconButtonProps } from "./icon-button";

export const COPIED_MS = 1200;

export type CopySource = string | (() => string | null | Promise<string | null>);

export interface CopyOptions {
  ms?: number;
  viaIpc?: boolean;
}

export function useCopied({ ms = COPIED_MS, viaIpc = false }: CopyOptions = {}): {
  copied: boolean;
  copy: (source: CopySource) => Promise<boolean>;
} {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(
    async (source: CopySource): Promise<boolean> => {
      const text = typeof source === "string" ? source : await source();
      if (!text) return false;
      if (viaIpc) {
        if (!(await copyTextViaIpc(text))) return false;
      } else {
        copyText(text);
      }
      setCopied(true);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), ms);
      return true;
    },
    [ms, viaIpc],
  );
  return { copied, copy };
}

interface CopyButtonProps extends CopyOptions {
  text: CopySource;
  label: string;
  copiedLabel?: string;
  variant?: "icon" | "text";
  icon?: LucideIcon;
  size?: IconButtonProps["size"];
  className?: string;
  tabIndex?: number;
  "data-testid"?: string;
}

export function CopyButton({
  text,
  label,
  copiedLabel,
  variant = "icon",
  icon,
  size,
  className,
  tabIndex,
  "data-testid": testId,
  ...options
}: CopyButtonProps) {
  const { copied, copy } = useCopied(options);
  const shownLabel = copied && copiedLabel ? copiedLabel : label;
  const Icon = copied ? Check : (icon ?? Copy);
  const glyph = <Icon className="size-3.5" />;
  const onClick = () => void copy(text);
  if (variant === "text") {
    return (
      <Button
        variant="outline"
        size="sm"
        className={className}
        tabIndex={tabIndex}
        aria-label={shownLabel}
        onClick={onClick}
        data-testid={testId}
      >
        {icon && glyph}
        {shownLabel}
      </Button>
    );
  }
  return (
    <IconButton
      label={shownLabel}
      size={size}
      className={className}
      tabIndex={tabIndex}
      onClick={onClick}
      data-testid={testId}
    >
      {glyph}
    </IconButton>
  );
}
