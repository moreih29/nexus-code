// The title bar's "what's new": after an update, the new version's release
// notes are a click away, until the user reads them or dismisses this.

import { Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { newsVersionOf } from "../../services/updates/release-notes";
import { markReleaseNotesSeen, showReleaseNotes } from "../../state/operations/release-notes";
import { useReleaseNotesStore } from "../../state/stores/release-notes";

export function ReleaseNewsButton() {
  const { t } = useTranslation();
  const lastSeen = useReleaseNotesStore((s) => s.lastSeenVersion);
  const version = newsVersionOf(lastSeen, __APP_VERSION__);
  if (!version) return null;

  return (
    <div
      className="app-no-drag mr-1.5 flex h-6 shrink-0 items-center rounded-full border border-border text-app-ui-sm text-muted-foreground"
      data-testid="release-news"
    >
      <button
        type="button"
        onClick={() => showReleaseNotes(version)}
        className="flex h-full items-center gap-1.5 rounded-l-full pl-2 pr-1.5 hover:bg-[var(--state-hover-bg)] hover:text-foreground"
      >
        <Sparkles className="size-3.5" aria-hidden="true" />
        <span>{t("releaseNotes.news", { version })}</span>
      </button>
      <button
        type="button"
        onClick={markReleaseNotesSeen}
        aria-label={t("releaseNotes.dismissNews")}
        title={t("releaseNotes.dismissNews")}
        className="flex h-full items-center rounded-r-full pl-1 pr-1.5 hover:bg-[var(--state-hover-bg)] hover:text-foreground"
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </div>
  );
}
