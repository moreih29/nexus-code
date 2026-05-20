/**
 * LSP language toggle chip for the workspace sidebar row.
 *
 * - Always visible; ON = brand color, OFF = grayscale + reduced opacity.
 * - Click toggles the enabled state: optimistic store update + IPC call.
 * - Wrapped in a Radix Tooltip showing the current state and action hint.
 * - aria-pressed reflects the ON/OFF state.
 */

import { Tooltip as RadixTooltip } from "radix-ui";
import type { LspLanguageId } from "../../../shared/types/app-state";
import { UI_TOOLTIP_DELAY_MS } from "../../../shared/util/timing-constants";
import { ipcCallResult } from "../../ipc/client";
import { useLspEnabledStore } from "../../state/stores/lsp-enabled";
import { PythonLogo } from "../icons/python-logo";
import { TypeScriptLogo } from "../icons/typescript-logo";

// ---------------------------------------------------------------------------
// Brand colors — design seal exemption for official language brand colors.
// Applied via inline style (not Tailwind) as approved in the task spec.
// ---------------------------------------------------------------------------

const BRAND_COLORS: Record<LspLanguageId, string> = {
  typescript: "#3178C6",
  python: "#3776AB",
};

// ---------------------------------------------------------------------------
// Sub-component: logo chooser
// ---------------------------------------------------------------------------

function LanguageLogo({
  languageId,
  className,
}: {
  languageId: LspLanguageId;
  className?: string;
}) {
  if (languageId === "typescript") {
    return <TypeScriptLogo className={className} />;
  }
  return <PythonLogo className={className} />;
}

// ---------------------------------------------------------------------------
// Chip
// ---------------------------------------------------------------------------

export interface LspLanguageChipProps {
  workspaceId: string;
  languageId: LspLanguageId;
  enabled: boolean;
}

export function LspLanguageChip({ workspaceId, languageId, enabled }: LspLanguageChipProps) {
  const label = languageId === "typescript" ? "TypeScript" : "Python";
  const tooltipText = enabled
    ? `${label} LSP: On — click to disable`
    : `${label} LSP: Off — click to enable`;

  function handleClick(e: React.MouseEvent) {
    // Stop propagation so the parent workspace-select button doesn't fire.
    e.stopPropagation();

    const current = useLspEnabledStore.getState().byWorkspace[workspaceId] ?? [];
    const next = enabled ? current.filter((l) => l !== languageId) : [...current, languageId];

    // Optimistic store update.
    useLspEnabledStore.getState().setForWorkspace(workspaceId, next);

    // Persist to main — fire-and-forget; main broadcasts enabledLanguagesChanged
    // which will re-confirm the store state via the ipcListen handler.
    void ipcCallResult("lsp", "setEnabledLanguages", {
      workspaceId,
      languages: next,
    });
  }

  return (
    <RadixTooltip.Root delayDuration={UI_TOOLTIP_DELAY_MS}>
      <RadixTooltip.Trigger asChild>
        <button
          type="button"
          aria-pressed={enabled}
          aria-label={tooltipText}
          onClick={handleClick}
          className="inline-flex items-center justify-center size-5 rounded-(--radius-control) transition-opacity duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          style={enabled ? { color: BRAND_COLORS[languageId] } : undefined}
        >
          <LanguageLogo
            languageId={languageId}
            className={enabled ? undefined : "opacity-40 grayscale"}
          />
        </button>
      </RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          className="px-2 py-1 text-app-micro bg-muted text-foreground border border-border rounded-(--radius-control) shadow-none"
          sideOffset={4}
        >
          {tooltipText}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
