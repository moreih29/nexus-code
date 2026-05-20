// src/renderer/components/settings/section.tsx — Shared section helpers.
//
// Three layout primitives reused by every Settings panel:
//   - SettingsSection: stacked label + control (full-width controls)
//   - SettingsRow:     inline label + compact control on the right
//   - ResetButton:     small ↺ icon button surfaced when a section is dirty;
//                      clicking reverts that section's fields to the token
//                      fallback (undefined in the store).
//
// Design seal: semantic tokens only, no shadows, lucide icons sized to the
// §14 grid (size-3).

import { RotateCcw } from "lucide-react";
import { cn } from "@/utils/cn";

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
        {dirty && onReset && <ResetButton onClick={onReset} label={`Reset ${label}`} />}
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
        {dirty && onReset && <ResetButton onClick={onReset} label={`Reset ${label}`} />}
      </div>
      <div className="flex items-center">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ResetButton — small icon button (not exported; surfaced via section helpers)
// ---------------------------------------------------------------------------

interface ResetButtonProps {
  onClick: () => void;
  label: string;
}

function ResetButton({ onClick, label }: ResetButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        "size-5 rounded-(--radius-control)",
        "text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
        "transition-colors",
      )}
    >
      <RotateCcw className="size-3" aria-hidden="true" />
    </button>
  );
}
