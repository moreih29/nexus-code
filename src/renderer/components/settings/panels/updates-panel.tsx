// src/renderer/components/settings/panels/updates-panel.tsx
//
// Controls: Update Channel (Stable / Beta segmented control) + "Check for
// Updates Now" button.
//
// Channel change → AppState `updateChannel` update via `appState.set` IPC.
// Main's installUpdatesDomain monkey-patches stateService.setState so the
// channel switch automatically resets ignoredUpdateVersion and fires a new
// auto-poll — the renderer just needs to call `appState.set`.
//
// "Check for Updates Now" → `updates.check({ trigger: "manual" })` IPC.
// Toast feedback is driven by the global `initUpdatesSubscriptions()` listener
// (registered once in bootstrap) — this component does not wire toasts itself.

import { useCallback, useState } from "react";
import { ipcCallResult } from "../../../ipc/client";
import { SegmentedControl } from "../segmented-control";
import { SettingsRow } from "../section";
import { Button } from "../../ui/button";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UpdateChannel = "stable" | "beta";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface UpdatesPanelProps {
  /** Current update channel from AppState. */
  channel: UpdateChannel;
  /** Callback invoked after the channel is persisted to AppState. */
  onChannelChange: (channel: UpdateChannel) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const CHANNEL_OPTIONS: Array<{ value: UpdateChannel; label: string }> = [
  { value: "stable", label: "Stable" },
  { value: "beta", label: "Beta" },
];

export function UpdatesPanel({ channel, onChannelChange }: UpdatesPanelProps) {
  const [checking, setChecking] = useState(false);

  const handleChannelChange = useCallback(
    (value: UpdateChannel) => {
      // Optimistic local update.
      onChannelChange(value);
      // Persist to AppState — main's monkey-patch handles ignoredVersion reset
      // and triggers an auto-poll automatically.
      void ipcCallResult("appState", "set", { updateChannel: value });
    },
    [onChannelChange],
  );

  const handleCheckNow = useCallback(() => {
    if (checking) return;
    setChecking(true);
    void ipcCallResult("updates", "check", { trigger: "manual" }).finally(() => {
      setChecking(false);
    });
  }, [checking]);

  return (
    <div className="flex flex-col gap-6">
      {/* Section: Update Channel */}
      <SettingsRow label="Update channel">
        <SegmentedControl
          label="Update channel"
          options={CHANNEL_OPTIONS}
          value={channel}
          onChange={handleChannelChange}
        />
      </SettingsRow>

      {/* Description for Beta channel */}
      {channel === "beta" && (
        <p className="text-app-ui-sm text-muted-foreground -mt-4">
          Beta channel includes pre-release versions and may be less stable.
        </p>
      )}

      {/* Action: Check for Updates Now */}
      <SettingsRow label="Check for updates">
        <Button
          variant="outline"
          size="sm"
          onClick={handleCheckNow}
          disabled={checking}
        >
          {checking ? "Checking…" : "Check Now"}
        </Button>
      </SettingsRow>
    </div>
  );
}
