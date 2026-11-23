/**
 * What the search panel says when it has no results to list: before a
 * search, when one failed (with a retry), and when one found nothing. A
 * workspace on another computer's search says the same.
 */
import { CircleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

export function SearchIdleMessage() {
  const { t } = useTranslation("files");
  return (
    <p className="px-4 py-4 text-app-ui-sm text-muted-foreground text-center">
      {t("search.state.idle")}
    </p>
  );
}

export function SearchFailedMessage({
  message,
  onRetry,
}: {
  message: string;
  /** Absent where trying again cannot help. */
  onRetry?: () => void;
}) {
  const { t } = useTranslation("files");
  return (
    <div className="px-4 py-4 flex flex-col items-center gap-2">
      <CircleAlert className="size-4 text-destructive" aria-hidden="true" />
      <p className="text-app-ui-sm text-muted-foreground text-center">{message}</p>
      {onRetry && (
        <button
          type="button"
          className="text-app-ui-sm text-primary underline underline-offset-2"
          onClick={onRetry}
        >
          {t("search.state.retry")}
        </button>
      )}
    </div>
  );
}

export function SearchNoResultsMessage() {
  const { t } = useTranslation("files");
  return (
    <div className="px-4 py-4 text-center flex flex-col gap-1">
      <p className="text-app-ui-sm text-foreground">{t("search.state.noResults")}</p>
      <p className="text-app-ui-sm text-muted-foreground">{t("search.state.noResultsHint")}</p>
    </div>
  );
}
