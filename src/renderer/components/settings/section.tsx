// src/renderer/components/settings/section.tsx — Shared section helpers.
//
// Layout primitives reused by every Settings panel:
//   - SettingsGroup:   settings that belong together, under a small section
//                      label, a rule above every group but the first
//   - SettingsRow:     a setting's name (and a line saying what it does) on
//                      the left, its compact control on the right
//   - SettingsSwitch:  an on/off setting — a SettingsRow with a Switch. On/off
//                      settings are switches; checkboxes are for picking
//                      items from a list and for filters.
//   - SettingsSection: a setting whose control is too wide for a row (a
//                      select of paths, a list): name above, control below
//   - ResetButton:     small ↺ icon button surfaced when a setting is dirty;
//                      clicking reverts it to the token fallback (undefined
//                      in the store).
//
// A setting's name reads in the foreground; group labels and descriptions are
// small and muted. A description is one line: what the setting does, not how.
//
// The reset button **always reserves its slot** (visibility:hidden when not
// active) so adjacent controls don't shift when the user first touches a
// value. Each row stays geometrically stable.
//
// Design seal: semantic tokens only, no shadows, lucide icons sized to the
// §14 grid (size-3).

import { RotateCcw } from "lucide-react";
import { type ReactNode, useId } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { IconButton } from "../ui/icon-button";
import { Switch } from "../ui/switch";

// A description is prose: a "=>" in it stays two characters rather than the
// UI font's arrow, as it reads where it names what ligatures do.
const DESCRIPTION_CLASS = "text-app-ui-sm text-muted-foreground [font-variant-ligatures:none]";

// ---------------------------------------------------------------------------
// SettingsGroup — a labelled group, ruled off from the one above
// ---------------------------------------------------------------------------

interface SettingsGroupProps {
  /** The group's label; a group without one is ruled off all the same. */
  title?: string;
  description?: ReactNode;
  /** A control beside the label that acts on the whole group, as a filter. */
  action?: ReactNode;
  /** A reset for the whole group, beside its label once it is changed. */
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

/** A panel's groups, one under another. */
export function SettingsPage({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-5">{children}</div>;
}

// ---------------------------------------------------------------------------
// The name of a setting, its reset, and the line saying what it does
// ---------------------------------------------------------------------------

interface SettingLabelProps {
  label: string;
  description?: ReactNode;
  /** The control the name labels, so clicking the name works it. */
  htmlFor?: string;
  dirty?: boolean;
  onReset?: () => void;
}

function SettingLabel({ label, description, htmlFor, dirty, onReset }: SettingLabelProps) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 items-center gap-1.5">
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
        {onReset && <ResetButton onClick={onReset} label={label} visible={!!dirty} />}
      </div>
      {description && <p className={DESCRIPTION_CLASS}>{description}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SettingsSection — name above, a wide control below
// ---------------------------------------------------------------------------

interface SettingsSectionProps extends SettingLabelProps {
  /** A small control beside the name, as a link to manage the choices. */
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

// ---------------------------------------------------------------------------
// SettingsRow — name on the left, control on the right
// ---------------------------------------------------------------------------

interface SettingsRowProps extends SettingLabelProps {
  children: ReactNode;
}

export function SettingsRow({
  label,
  description,
  htmlFor,
  dirty,
  onReset,
  children,
}: SettingsRowProps) {
  return (
    <div className="flex items-center justify-between gap-4">
      <SettingLabel
        label={label}
        description={description}
        htmlFor={htmlFor}
        dirty={dirty}
        onReset={onReset}
      />
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SettingsSwitch — an on/off setting
// ---------------------------------------------------------------------------

interface SettingsSwitchProps {
  label: string;
  description?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  /** As SettingsRow: a reset affordance next to the label once changed. */
  dirty?: boolean;
  onReset?: () => void;
}

export function SettingsSwitch({
  label,
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
      description={description}
      htmlFor={id}
      dirty={dirty}
      onReset={onReset}
    >
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </SettingsRow>
  );
}

// ---------------------------------------------------------------------------
// ResetButton — small icon button (always rendered, slot reserved)
// ---------------------------------------------------------------------------

interface ResetButtonProps {
  onClick: () => void;
  /** The setting's label; the button reads "Reset <label>" in the UI language. */
  label: string;
  /**
   * When false the button keeps its layout slot (visibility:hidden) but
   * doesn't accept clicks or focus. This is intentional: hiding the button
   * via conditional render shifts neighbour controls on first edit, which
   * surprised users in earlier iterations.
   */
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
