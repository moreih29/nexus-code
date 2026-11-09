// src/renderer/components/settings/font-combobox.tsx — An installed font, by name.
//
// The field the font settings' "Other…" opens: what is typed narrows a list
// of the fonts installed here, under the field, and a font takes effect only
// once it is picked (a click, or Enter on the one marked), or its whole name
// is typed. Typing alone changes nothing, so the editor, the terminal and the
// chat tabs are not laid out again on every key. Where the fonts cannot be
// listed, the name typed is taken as it is, on Enter or on leaving.

import { Popover as RadixPopover } from "radix-ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import {
  familyNamed,
  localFontFamilies,
  matchFamilies,
} from "../../services/editor/runtime/local-fonts";

/** Most fonts listed at once; typing narrows the rest. */
const MAX_LISTED = 200;

/** The installed families: undefined while read, null when they cannot be listed. */
function useLocalFontFamilies(): readonly string[] | null | undefined {
  const [families, setFamilies] = useState<readonly string[] | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void localFontFamilies().then((read) => {
      if (live) setFamilies(read);
    });
    return () => {
      live = false;
    };
  }, []);
  return families;
}

export function FontCombobox({
  id,
  value,
  onPick,
  placeholder,
}: {
  id: string;
  /** The font in effect, by name; "" for none. */
  value: string;
  onPick: (family: string) => void;
  placeholder: string;
}) {
  const { t } = useTranslation("settings");
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const families = useLocalFontFamilies();
  const [text, setText] = useState(value);
  // Whether the text is a query, typed since the list opened, or the font in effect.
  const [typed, setTyped] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // The font changed elsewhere (reset): the field shows it.
  const [shownFor, setShownFor] = useState(value);
  if (shownFor !== value) {
    setShownFor(value);
    setText(value);
    setTyped(false);
  }

  const matches = useMemo(
    () => (families ? matchFamilies(families, typed ? text : "") : []),
    [families, typed, text],
  );
  const listed = matches.slice(0, MAX_LISTED);

  // The font marked stays in sight as the arrows move it.
  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const show = () => {
    setOpen(true);
    setTyped(false);
    // Opened on the font in effect, it is marked among them all.
    setActive(families && value ? families.indexOf(value) : -1);
  };

  const pick = (family: string) => {
    setText(family);
    setTyped(false);
    setOpen(false);
    if (family !== value) onPick(family);
  };

  /** Leaves the name typed: a font's whole name takes it; anything else goes back to the font in effect. */
  const settle = () => {
    setOpen(false);
    const name = text.trim();
    if (name === "" || name === value) {
      setText(value);
      setTyped(false);
      return;
    }
    if (families === null) {
      pick(name);
      return;
    }
    const found = families ? familyNamed(families, name) : undefined;
    if (found) pick(found);
    else {
      setText(value);
      setTyped(false);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        show();
        return;
      }
      if (listed.length === 0) return;
      const by = event.key === "ArrowDown" ? 1 : -1;
      setActive((at) =>
        at < 0 ? (by > 0 ? 0 : listed.length - 1) : (at + by + listed.length) % listed.length,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      const marked = open ? listed[active] : undefined;
      if (marked) pick(marked);
      else settle();
    } else if (event.key === "Escape" && open) {
      // The list closes, not the settings.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setText(value);
      setTyped(false);
    }
  };

  const listOpen = open && families !== null;
  return (
    <RadixPopover.Root open={listOpen} onOpenChange={(next) => !next && setOpen(false)}>
      <RadixPopover.Anchor asChild>
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={listOpen}
          aria-controls={listOpen ? listId : undefined}
          aria-activedescendant={listOpen && active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setTyped(true);
            setOpen(true);
            setActive(event.target.value.trim() === "" ? -1 : 0);
          }}
          onFocus={show}
          onClick={() => !open && show()}
          onBlur={settle}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className={cn(
            "w-full rounded-(--radius-control) border border-border bg-background px-2 py-1",
            "text-app-body text-foreground outline-none placeholder:text-muted-foreground",
            "focus-visible:ring-1 focus-visible:ring-ring",
          )}
          data-testid="font-combobox-input"
        />
      </RadixPopover.Anchor>
      <RadixPopover.Portal>
        <RadixPopover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          // The keyboard stays in the field.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            if (event.target === inputRef.current) event.preventDefault();
          }}
          className={cn(
            "floating-panel z-(--layer-floating) w-(--radix-popover-trigger-width) p-1 outline-none",
            "max-h-[min(15rem,var(--radix-popover-content-available-height))] overflow-y-auto app-scrollbar",
          )}
          data-testid="font-combobox-list"
        >
          <div ref={listRef} id={listId} role="listbox" aria-label={t("fontPicker.list")}>
            {families === undefined ? (
              <div className="px-2 py-1 text-app-ui-sm text-muted-foreground">
                {t("fontPicker.loading")}
              </div>
            ) : listed.length === 0 ? (
              <div className="px-2 py-1 text-app-ui-sm text-muted-foreground">
                {t("fontPicker.noMatch")}
              </div>
            ) : (
              listed.map((family, index) => (
                <button
                  type="button"
                  tabIndex={-1}
                  key={family}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  data-index={index}
                  // A press keeps the keyboard in the field.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(family)}
                  onMouseMove={() => index !== active && setActive(index)}
                  className={cn(
                    "flex w-full cursor-default items-center rounded-(--radius-control) px-2 py-1 text-left text-app-ui-sm",
                    index === active && "bg-[var(--state-active-bg)]",
                    family === value && "text-[var(--state-selected-indicator)]",
                  )}
                >
                  <span className="min-w-0 truncate">{family}</span>
                </button>
              ))
            )}
            {matches.length > listed.length && (
              <div className="px-2 py-1 text-app-micro text-muted-foreground">
                {t("fontPicker.more", { count: matches.length - listed.length })}
              </div>
            )}
          </div>
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
