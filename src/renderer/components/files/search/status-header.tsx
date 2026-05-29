/**
 * Status header: "X results in Y files" + Loader2 spinner (after 250ms delay)
 * + cancel button + limit-hit pill.
 */

import { Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { SearchSession } from "../../../state/stores/search";
import { Button } from "../../ui/button";

const LOADER_DELAY_MS = 250;

interface SearchStatusHeaderProps {
  session: SearchSession;
  showLoader: boolean;
  onCancel: () => void;
}

export function SearchStatusHeader({ session, showLoader, onCancel }: SearchStatusHeaderProps) {
  const { t } = useTranslation("files");
  const { status, matchesFound, results, limitHit } = session;

  const fileCount = results.length;

  return (
    <div className="flex flex-col gap-0.5 px-2 pt-1">
      <div className="flex items-center justify-between gap-1 min-h-[22px]">
        <span className="text-app-ui-sm text-muted-foreground truncate">
          {status === "done" || status === "running"
            ? t("search.status.results", { count: matchesFound, fileCount })
            : null}
        </span>
        {status === "running" && showLoader && (
          <div className="flex items-center gap-1 shrink-0">
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("search.status.cancel")}
              className="size-5"
              onClick={onCancel}
            >
              <X className="size-3" aria-hidden="true" />
            </Button>
          </div>
        )}
      </div>
      {limitHit && (
        <div
          className={cn(
            "rounded px-2 py-0.5 text-app-ui-sm text-muted-foreground bg-muted",
          )}
          role="status"
        >
          {t("search.status.limitHit", { count: matchesFound })}
        </div>
      )}
    </div>
  );
}

export { LOADER_DELAY_MS };
