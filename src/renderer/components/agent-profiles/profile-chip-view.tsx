import { Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Popover } from "../ui/popover";
import { tooltipProps } from "../ui/tooltip";
import { ProfileDot } from "./profile-badge";

export interface ProfileChipDetail {
  label: string;
  value: string;
  mono?: boolean;
}

export interface ProfileChipOther {
  id: string;
  name: string;
  color: string;
}

export function ProfileChipView({
  name,
  color,
  details,
  others,
  conversation,
  busy,
  open,
  onOpenChange,
  onPick,
  controls = true,
  compact = false,
  testIdPrefix,
}: {
  name: string;
  color: string;
  details: readonly ProfileChipDetail[];
  others: readonly ProfileChipOther[] | null;
  conversation: boolean;
  busy: "stops" | "waits" | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (id: string, fresh: boolean) => void;
  controls?: boolean;
  compact?: boolean;
  testIdPrefix: string;
}) {
  const { t } = useTranslation();
  const label = compact ? { "aria-label": name, ...tooltipProps(name) } : {};
  const chip = (
    <>
      <ProfileDot color={color} className="size-1.5" />
      {!compact && <span className="max-w-28 truncate">{name}</span>}
    </>
  );
  if (!controls) {
    return (
      <span
        className="flex shrink-0 items-center gap-1 whitespace-nowrap px-1"
        data-testid={`${testIdPrefix}-chip`}
        {...label}
      >
        {chip}
      </span>
    );
  }
  const waits = busy === "waits";
  const pick = (id: string, fresh: boolean) => {
    onOpenChange(false);
    onPick(id, fresh);
  };
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      label={t("chat.profile.title")}
      side="top"
      align="end"
      className="w-72"
      testId={`${testIdPrefix}-popover`}
      trigger={
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-(--radius-control) px-1 hover:bg-[var(--state-hover-bg)] hover:text-foreground"
          data-testid={`${testIdPrefix}-chip`}
          {...label}
        >
          {chip}
        </button>
      }
    >
      <div className="flex flex-col gap-2 px-2 py-1.5 text-app-ui-sm">
        <div className="flex items-center gap-1.5 text-app-body text-foreground">
          <ProfileDot color={color} />
          <span className="truncate">{name}</span>
        </div>
        {details.length > 0 && (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            {details.map((detail) => (
              <div key={detail.label} className="contents">
                <dt className="text-muted-foreground">{detail.label}</dt>
                <dd
                  className={detail.mono ? "truncate font-mono" : "truncate"}
                  title={detail.value}
                >
                  {detail.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {others && others.length > 0 && (
          <div className="flex flex-col border-t border-border pt-1.5">
            <span className="pb-0.5 text-app-micro text-muted-foreground">
              {t(conversation ? "chat.profile.continueIn" : "chat.profile.switchTo")}
            </span>
            {waits ? (
              <span
                className="pb-0.5 text-app-micro text-(--state-warning-fg)"
                data-testid={`${testIdPrefix}-busy`}
              >
                {t("agentView.remote.profileBusy")}
              </span>
            ) : busy === "stops" ? (
              <span
                className="flex items-center gap-1 pb-0.5 text-app-micro text-(--state-warning-fg)"
                data-testid={`${testIdPrefix}-stops`}
              >
                <Square className="size-2.5 fill-current" aria-hidden="true" />
                {t("chat.profile.stops")}
              </span>
            ) : null}
            {others.map((other) => (
              <div
                key={other.id}
                className="-mx-1 flex items-center rounded-(--radius-control) hover:bg-[var(--state-hover-bg)]"
              >
                <button
                  type="button"
                  disabled={waits}
                  onClick={() => pick(other.id, !conversation)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-(--radius-control) px-1 py-0.5 text-left disabled:opacity-40"
                  data-testid={`${testIdPrefix}-pick`}
                >
                  <ProfileDot color={other.color} />
                  <span className="truncate">{other.name}</span>
                </button>
                {conversation && (
                  <button
                    type="button"
                    disabled={waits}
                    onClick={() => pick(other.id, true)}
                    className="shrink-0 whitespace-nowrap rounded-(--radius-control) px-1.5 py-0.5 text-app-micro text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground disabled:opacity-40"
                    data-testid={`${testIdPrefix}-new`}
                  >
                    {t("chat.profile.newChat")}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Popover>
  );
}
