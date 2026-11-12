// The list over the composer that completes a `/` command or an `@` file.
// The composer keeps the keys (↑ ↓ to move, ↩ or tab to pick, esc to
// close); a click picks without taking the focus from the message box. A
// command that matches nothing says so, as the app's other pickers do; a
// file search, answered later, shows only what it found.

import { FileText, Folder, Slash } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../utils/cn";

export interface CompletionItem {
  key: string;
  label: string;
  /** Beside the label: a command's arguments. */
  hint?: string;
  /** Under it: a command's description. */
  detail?: string;
  icon: "command" | "file" | "folder";
}

interface CompletionMenuProps {
  kind: "command" | "file";
  items: CompletionItem[];
  active: number;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
}

export function CompletionMenu({ kind, items, active, onPick, onHover }: CompletionMenuProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [active]);
  if (items.length === 0) {
    if (kind !== "command") return null;
    return (
      <div
        role="status"
        className="absolute right-0 bottom-full left-0 z-30 mb-1 rounded-(--radius-raised) border border-border bg-popover px-2 py-1.5 text-app-ui-sm text-muted-foreground"
        data-testid="chat-completion-empty"
      >
        {t("chat.composer.no_commands")}
      </div>
    );
  }
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={kind === "command" ? t("chat.composer.commands") : t("chat.composer.files")}
      className="app-scrollbar absolute right-0 bottom-full left-0 z-30 mb-1 max-h-64 overflow-y-auto rounded-(--radius-raised) border border-border bg-popover py-1"
      data-testid="chat-completion"
    >
      {items.map((item, i) => {
        const Icon = item.icon === "command" ? Slash : item.icon === "folder" ? Folder : FileText;
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the message box has the keys
          <div
            key={item.key}
            role="option"
            aria-selected={i === active}
            data-index={i}
            tabIndex={-1}
            // The message box keeps the focus, and with it the caret.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(i)}
            onMouseMove={() => i !== active && onHover(i)}
            className={cn(
              "flex cursor-pointer items-start gap-2 px-2 py-1 text-app-ui-sm",
              i === active && "bg-[var(--state-hover-bg)]",
            )}
          >
            <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-baseline gap-2">
                <span
                  className={cn("truncate", item.icon !== "command" && "font-mono text-app-micro")}
                >
                  {item.label}
                </span>
                {item.hint && (
                  <span className="truncate text-app-micro text-muted-foreground">{item.hint}</span>
                )}
              </div>
              {item.detail && (
                <div className="truncate text-app-micro text-muted-foreground" title={item.detail}>
                  {item.detail}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
