import { AlertCircle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { BannerDismissButton } from "../../ui/banner";

const NOTICE_BOX =
  "rounded-(--radius-control) border border-[var(--state-error-border)] bg-[var(--state-error-bg)]";

export interface ErrorNoticeProps {
  readonly message: string;
  readonly className?: string;
  readonly iconSize?: "sm" | "md";
  readonly textClass?: string;
  readonly children?: React.ReactNode;
}

export function ErrorNotice({
  message,
  className,
  iconSize = "sm",
  textClass = "text-app-ui-sm",
  children,
}: ErrorNoticeProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const [closedMessage, setClosedMessage] = useState<string | null>(null);
  if (closedMessage === message) return null;
  if (closedMessage !== null) setClosedMessage(null);
  const content = (
    <>
      <AlertCircle
        className={cn(
          "mt-0.5 shrink-0 text-[var(--state-error-fg)]",
          iconSize === "md" ? "size-4" : "size-3.5",
        )}
        aria-hidden="true"
      />
      <span className={cn("min-w-0 flex-1 text-[var(--state-error-fg)]", textClass)}>
        {message}
      </span>
      <BannerDismissButton
        dismiss={{ label: t("action.dismiss"), onDismiss: () => setClosedMessage(message) }}
        className="-my-0.5"
      />
    </>
  );

  if (children) {
    return (
      <div className={cn("flex flex-col gap-2", NOTICE_BOX, className)} role="alert">
        <div className="flex items-start gap-2">{content}</div>
        {children}
      </div>
    );
  }
  return (
    <div className={cn("flex items-start gap-2", NOTICE_BOX, className)} role="alert">
      {content}
    </div>
  );
}
