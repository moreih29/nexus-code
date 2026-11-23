import { RotateCcw } from "lucide-react";
import { type ReactNode, useId } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { IconButton } from "../ui/icon-button";
import { Switch } from "../ui/switch";

const DESCRIPTION_CLASS = "text-app-ui-sm text-muted-foreground [font-variant-ligatures:none]";

interface SettingsGroupProps {
  title?: string;
  description?: ReactNode;
  action?: ReactNode;
  dirty?: boolean;
  onReset?: () => void;
  children: ReactNode;
}

export function SettingsGroup({
  title,
  description,
  action,
  dirty,
  onReset,
  children,
}: SettingsGroupProps) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={title ? headingId : undefined}
      className="flex flex-col gap-3.5 border-t border-border pt-5 first:border-t-0 first:pt-0"
    >
      {(title || action) && (
        <div className="flex items-end justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            {title && (
              <div className="flex items-center gap-1.5">
                <h3 id={headingId} className="text-app-label uppercase text-muted-foreground">
                  {title}
                </h3>
                {onReset && <ResetButton onClick={onReset} label={title} visible={!!dirty} />}
              </div>
            )}
            {description && <p className={DESCRIPTION_CLASS}>{description}</p>}
          </div>
          {action && <div className="flex shrink-0 items-center">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function SettingsPage({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-5">{children}</div>;
}

interface SettingLabelProps {
  label: string;
  code?: string;
  description?: ReactNode;
  htmlFor?: string;
  dirty?: boolean;
  onReset?: () => void;
}

function SettingLabel({
  label,
  code,
  description,
  htmlFor,
  dirty,
  onReset,
  className,
}: SettingLabelProps & { className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <div className={cn("flex min-w-0 items-center gap-1.5", code && "flex-wrap gap-y-0.5")}>
        {htmlFor ? (
          <label
            htmlFor={htmlFor}
            className="truncate text-app-body text-foreground cursor-pointer"
          >
            {label}
          </label>
        ) : (
          <span className="truncate text-app-body text-foreground">{label}</span>
        )}
        {code && (
          <span className="min-w-0 break-all rounded-(--radius-control) bg-muted px-1 font-mono text-app-micro text-muted-foreground">
            {code}
          </span>
        )}
        {onReset && <ResetButton onClick={onReset} label={label} visible={!!dirty} />}
      </div>
      {description && <p className={DESCRIPTION_CLASS}>{description}</p>}
    </div>
  );
}

interface SettingsSectionProps extends SettingLabelProps {
  action?: ReactNode;
  children: ReactNode;
}

export function SettingsSection({
  label,
  description,
  htmlFor,
  dirty,
  onReset,
  action,
  children,
}: SettingsSectionProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-4">
        <SettingLabel label={label} htmlFor={htmlFor} dirty={dirty} onReset={onReset} />
        {action}
      </div>
      {children}
      {description && <p className={DESCRIPTION_CLASS}>{description}</p>}
    </div>
  );
}

interface SettingsRowProps extends SettingLabelProps {
  children: ReactNode;
}

export function SettingsRow({
  label,
  code,
  description,
  htmlFor,
  dirty,
  onReset,
  children,
}: SettingsRowProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <SettingLabel
        label={label}
        code={code}
        description={description}
        htmlFor={htmlFor}
        dirty={dirty}
        onReset={onReset}
        className="min-w-40 flex-1 basis-40"
      />
      <div className="ml-auto flex max-w-full shrink-0 items-center">{children}</div>
    </div>
  );
}

interface SettingsSwitchProps {
  label: string;
  code?: string;
  description?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  dirty?: boolean;
  onReset?: () => void;
}

export function SettingsSwitch({
  label,
  code,
  description,
  checked,
  disabled,
  onChange,
  dirty,
  onReset,
}: SettingsSwitchProps) {
  const id = useId();
  return (
    <SettingsRow
      label={label}
      code={code}
      description={description}
      htmlFor={id}
      dirty={dirty}
      onReset={onReset}
    >
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </SettingsRow>
  );
}

interface ResetButtonProps {
  onClick: () => void;
  label: string;
  visible: boolean;
}

function ResetButton({ onClick, label, visible }: ResetButtonProps) {
  const { t } = useTranslation("settings");
  const resetLabel = t("dialog.resetSetting", { label });
  return (
    <IconButton
      label={resetLabel}
      size="xs"
      onClick={onClick}
      tabIndex={visible ? 0 : -1}
      aria-hidden={!visible || undefined}
      className={cn("shrink-0", !visible && "invisible pointer-events-none")}
    >
      <RotateCcw className="size-3" aria-hidden="true" />
    </IconButton>
  );
}
