import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../../utils/cn";
import type { BannerDismiss } from "../../../ui/banner";
import type { PushGuardActionKind } from "../utils/push-guard-banner";
import type { BannerSlotItem, GitBannerModel } from "./banner-model";
import { GitInlineBanner } from "./inline-banner";

export interface GitBannerStackProps {
  model: GitBannerModel;
  dismissals: Partial<Record<BannerSlotItem["kind"], BannerDismiss>>;
}

function renderBannerItem(
  item: BannerSlotItem,
  dismiss: BannerDismiss | undefined,
): React.ReactNode {
  switch (item.kind) {
    case "push-guard":
      return (
        <GitInlineBanner
          key="push-guard"
          dismiss={dismiss}
          variant={item.view.variant}
          message={item.view.message}
          details={item.view.details}
          actions={item.view.actions.map((action) => ({
            label: action.label,
            variant:
              action.destructive === true
                ? "destructive"
                : action.kind === "cancel"
                  ? "ghost"
                  : "default",
            onAction: () => (item.onAction as (k: PushGuardActionKind) => void)(action.kind),
          }))}
        />
      );

    case "error":
      return (
        <GitInlineBanner
          key="error"
          dismiss={dismiss}
          variant="error"
          message={item.message}
          details={item.details}
          actionLabel={item.actionLabel}
          onAction={item.onAction}
        />
      );

    case "autofetch-paused":
      return (
        <GitInlineBannerAutofetchPaused
          key="autofetch-paused"
          dismiss={dismiss}
          details={item.details}
          onResume={item.onResume}
        />
      );

    case "helper-prompt":
      return <GitInlineBanner key="helper-prompt" variant="info" message={item.message} />;

    case "context":
      return (
        <GitInlineBanner
          key="context"
          dismiss={dismiss}
          variant={item.variant}
          message={item.message}
        />
      );
  }
}

function GitInlineBannerAutofetchPaused({
  details,
  onResume,
  dismiss,
}: {
  details?: string;
  onResume: () => void;
  dismiss?: BannerDismiss | undefined;
}) {
  const { t } = useTranslation("files");
  return (
    <GitInlineBanner
      variant="warning"
      dismiss={dismiss}
      message={t("git.panel.banners.autofetchPaused")}
      details={details}
      actionLabel={t("git.panel.banners.resume")}
      onAction={onResume}
    />
  );
}

interface CounterRowProps {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}

function CounterRow({ count, expanded, onToggle }: CounterRowProps) {
  const { t } = useTranslation("files");
  return (
    <button
      type="button"
      className={cn(
        "flex h-6 w-full shrink-0 items-center gap-1 border-b border-border bg-muted px-3",
        "text-app-ui-sm text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
      )}
      aria-expanded={expanded}
      aria-label={
        expanded
          ? t("git.panel.banners.collapseNotifications")
          : t("git.panel.banners.moreNotifications", { count })
      }
      onClick={onToggle}
    >
      <span className="min-w-0 flex-1 truncate text-left">
        {expanded
          ? t("git.panel.banners.collapse")
          : t("git.panel.banners.notifications", { count })}
      </span>
      <ChevronDown
        className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-180")}
        aria-hidden="true"
      />
    </button>
  );
}

export function GitBannerStack({ model, dismissals }: GitBannerStackProps) {
  const [expanded, setExpanded] = useState(false);

  const { slotItem, collapsedItems, collapsedCount } = model;

  if (!slotItem) return null;

  const showCounter = collapsedCount > 0;

  return (
    <div className="flex flex-col">
      {renderBannerItem(slotItem, dismissals[slotItem.kind])}

      {expanded && collapsedItems.map((item) => renderBannerItem(item, dismissals[item.kind]))}

      {showCounter ? (
        <CounterRow
          count={collapsedCount}
          expanded={expanded}
          onToggle={() => setExpanded((prev) => !prev)}
        />
      ) : null}
    </div>
  );
}
