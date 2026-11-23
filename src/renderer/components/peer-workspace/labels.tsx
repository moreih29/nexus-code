import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";

export function PeerReadOnlyBadge({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  if (compact) {
    return (
      <span
        role="img"
        aria-label={t("peerWorkspace.readOnly")}
        className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-full border border-[var(--state-warning-fg)]/45 text-[var(--state-warning-fg)]"
      >
        <Lock className="size-3" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border border-[var(--state-warning-fg)]/45 px-1.5 text-app-micro text-[var(--state-warning-fg)]">
      <Lock className="size-3" aria-hidden="true" />
      {t("peerWorkspace.readOnly")}
    </span>
  );
}
