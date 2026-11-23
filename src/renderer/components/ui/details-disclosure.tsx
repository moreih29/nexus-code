/**
 * DetailsDisclosure — a collapsed "Details" toggle over raw diagnostic text.
 *
 * Banners and toasts lead with a short message; the full output behind it
 * (a git stderr dump, for one) stays one click away instead of pushing the
 * surface's other content aside. The text keeps its line breaks and scrolls
 * once it outgrows a few lines.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { ToggleChevron } from "./toggle-chevron";

export interface DetailsDisclosureProps {
  details: string;
  className?: string;
}

export function DetailsDisclosure({ details, className }: DetailsDisclosureProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <button
        type="button"
        aria-expanded={open}
        className="inline-flex cursor-pointer items-center gap-0.5 self-start border-0 bg-transparent p-0 text-app-ui-sm opacity-80 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={() => setOpen((prev) => !prev)}
      >
        {open ? t("action.hide_details") : t("action.show_details")}
        <ToggleChevron open={open} className="size-3 text-current" />
      </button>
      {open ? (
        <pre className="app-scrollbar max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-mono text-app-ui-sm">
          {details}
        </pre>
      ) : null}
    </div>
  );
}
