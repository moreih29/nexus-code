// src/renderer/components/settings/section.tsx — Shared section helpers.
//
// Layout primitives reused by every Settings panel:
//   - SettingsSection: stacked label + control (full-width controls)
//   - SettingsRow:     inline label + compact control on the right
//   - SettingsSwitch:  an on/off setting — label and description, a Switch on
//                      the right. On/off settings are switches; checkboxes are
//                      for picking items from a list and for filters.
//   - ResetButton:     small ↺ icon button surfaced when a section is dirty;
//                      clicking reverts that section's fields to the token
//                      fallback (undefined in the store).
//
// The reset button **always reserves its slot** (visibility:hidden when not
// active) so adjacent controls don't shift when the user first touches a
// value. Each row stays geometrically stable.
//
// Design seal: semantic tokens only, no shadows, lucide icons sized to the
// §14 grid (size-3).

import { RotateCcw } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { Switch } from "../ui/switch";

// ---------------------------------------------------------------------------
// SettingsSection — stacked layout
// ---------------------------------------------------------------------------

interface SettingsSectionProps {
  label: string;
  /** When true, shows a small ↺ reset affordance next to the label. */
  dirty?: boolean;
  /** Called when the user clicks reset. Required if `dirty` is ever true. */
  onReset?: () => void;
  children: React.ReactNode;
}

export function SettingsSection({ label, dirty, onReset, children }: SettingsSectionProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-app-ui-sm text-muted-foreground">{label}</span>
        <ResetButton onClick={onReset ?? (() => {})} label={label} visible={!!(dirty && onReset)} />
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SettingsRow — inline layout
// ---------------------------------------------------------------------------

interface SettingsRowProps {
  label: string;
  dirty?: boolean;
  onReset?: () => void;
  children: React.ReactNode;
}

export function SettingsRow({ label, dirty, onReset, children }: SettingsRowProps) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-app-body text-foreground truncate">{label}</span>
        <ResetButton onClick={onReset ?? (() => {})} label={label} visible={!!(dirty && onReset)} />
      </div>
      <div className="flex items-center">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SettingsSwitch — an on/off setting
// ---------------------------------------------------------------------------

interface SettingsSwitchProps {
  label: string;
  description?: React.ReactNode;
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
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <label htmlFor={id} className="text-app-body text-foreground cursor-pointer">
            {label}
          </label>
          {onReset && <ResetButton onClick={onReset} label={label} visible={!!dirty} />}
        </div>
        {description && <p className="text-app-ui-sm text-muted-foreground">{description}</p>}
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        className="shrink-0 mt-1"
      />
    </div>
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
    <button
      type="button"
      aria-label={resetLabel}
      title={resetLabel}
      onClick={onClick}
      tabIndex={visible ? 0 : -1}
      aria-hidden={!visible || undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        "size-5 rounded-(--radius-control)",
        "text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
        "transition-colors",
        !visible && "invisible pointer-events-none",
      )}
    >
      <RotateCcw className="size-3" aria-hidden="true" />
    </button>
  );
}
