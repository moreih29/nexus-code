// src/renderer/components/settings/panels/browser-permissions-panel.tsx
//
// Browser Permissions settings panel.
//
// (a) Global toggle section — lets the user pre-approve permission kinds for
//     all workspaces.  Tier A items are always visible; Tier B items are
//     collapsed under an "Advanced" disclosure.
//
// (b) Site memory section — lists previously remembered per-origin permission
//     decisions with a segmented-control filter (current workspace / all).
//     Each row shows the origin, permission badges, and a revoke button.
//
// Design: semantic tokens only (no hex/rgba/oklch literals, no box-shadow).

import i18next from "i18next";
import type { LucideIcon } from "lucide-react";
import {
  Bell,
  Clipboard,
  Clock,
  ExternalLink,
  FolderOpen,
  LayoutGrid,
  Lock,
  MapPin,
  Maximize,
  MonitorUp,
  Music,
  ShieldCheck,
  Trash2,
  Video,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { createLogger } from "../../../../shared/log/renderer";
import type { BrowserPermissionKind } from "../../../../shared/security/browser-permissions";
import { PERMISSION_TOGGLES } from "../../../../shared/security/browser-permissions";
import { ipcCallResult } from "../../../ipc/client";
import { useActiveStore } from "../../../state/stores/active";
import { useBrowserPermissionsStore } from "../../../state/stores/browser-permissions";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { showConfirmDialog } from "../../ui/confirm-dialog";
import { EmptyState } from "../../ui/empty-state";
import { Skeleton, SkeletonLine } from "../../ui/skeleton";
import { Switch } from "../../ui/switch";
import { SegmentedControl } from "../segmented-control";

const log = createLogger("browser-permissions");

// Map from PERMISSION_TOGGLES key → settings i18n key (without "browserPermissions.permission." prefix)
const TOGGLE_I18N_KEY: Record<string, string> = {
  media: "media",
  geolocation: "geolocation",
  notifications: "notifications",
  "display-capture": "displayCapture",
  "clipboard-read": "clipboardRead",
  openExternal: "openExternal",
  fileSystem: "fileSystem",
  "midi+midiSysex": "midi",
  fullscreen: "fullscreen",
  "pointerLock+keyboardLock": "inputLock",
  "idle-detection": "idleDetection",
  "window-management": "windowManagement",
  "speaker-selection": "speakerSelection",
  mediaKeySystem: "drm",
};

// Map from BrowserPermissionKind → settings i18n permissionLabel key
const PERMISSION_LABEL_I18N_KEY: Record<string, string> = {
  "clipboard-read": "clipboardRead",
  "clipboard-sanitized-write": "clipboardSanitizedWrite",
  "display-capture": "displayCapture",
  fullscreen: "fullscreen",
  geolocation: "geolocation",
  "idle-detection": "idleDetection",
  media: "media",
  mediaKeySystem: "mediaKeySystem",
  midi: "midi",
  midiSysex: "midiSysex",
  notifications: "notifications",
  pointerLock: "pointerLock",
  keyboardLock: "keyboardLock",
  openExternal: "openExternal",
  "speaker-selection": "speakerSelection",
  "storage-access": "storageAccess",
  "top-level-storage-access": "topLevelStorageAccess",
  "window-management": "windowManagement",
  unknown: "unknown",
  fileSystem: "fileSystem",
};

// ---------------------------------------------------------------------------
// Icon map — keyed by the Lucide name string from PERMISSION_TOGGLES
// ---------------------------------------------------------------------------

const ICON_MAP: Record<string, LucideIcon> = {
  Video,
  MapPin,
  Bell,
  MonitorUp,
  Clipboard,
  ExternalLink,
  FolderOpen,
  Music,
  Maximize,
  Lock,
  Clock,
  LayoutGrid,
  Volume2,
  ShieldCheck,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RememberedEntry {
  workspaceId: string;
  origin: string;
  permission: BrowserPermissionKind;
  decision: "allow" | "block";
}

type ScopeTab = "current" | "all";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BrowserPermissionsPanel() {
  const { t } = useTranslation("settings");
  const grants = useBrowserPermissionsStore((s) => s.grants);
  const setGrant = useBrowserPermissionsStore((s) => s.setGrant);

  const activeWorkspaceId = useActiveStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspacesStore((s) => s.workspaces);

  const [scopeTab, setScopeTab] = useState<ScopeTab>("current");
  const [entries, setEntries] = useState<RememberedEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fetchRef = useRef(0);

  // Load remembered entries whenever the scope tab or active workspace changes.
  //
  // We intentionally do NOT reset `entries` to null here. Switching the scope
  // segmented control (current ↔ all) re-runs this loader; clearing to null
  // would unmount the list and render the loading skeleton for a frame, which
  // collapses the panel height and makes the surrounding settings modal visibly
  // jump/flicker. Keeping the previous list mounted until the (near-instant
  // local IPC) result arrives keeps the height stable. The skeleton still shows
  // on the very first load, when `entries` is null before any fetch resolves.
  const loadEntries = useCallback(async () => {
    const token = ++fetchRef.current;
    setLoadError(null);

    const workspaceId = scopeTab === "current" && activeWorkspaceId ? activeWorkspaceId : undefined;

    const result = await ipcCallResult("browserPermission", "listRemembered", {
      workspaceId,
    });

    if (token !== fetchRef.current) return; // stale

    if (!result.ok) {
      setLoadError(result.message ?? t("browserPermissions.loadFailed"));
      setEntries([]);
      return;
    }
    setEntries(result.value as RememberedEntry[]);
  }, [scopeTab, activeWorkspaceId]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  const handleRevoke = useCallback(
    async (entry: RememberedEntry) => {
      const confirmed = await showConfirmDialog({
        title: t("browserPermissions.deleteTitle"),
        description: t("browserPermissions.deleteDescription"),
        confirmLabel: t("browserPermissions.deleteConfirm"),
        cancelLabel: i18next.t("common:action.cancel"),
        variant: "destructive",
      });
      if (!confirmed) return;

      const revokeResult = await ipcCallResult("browserPermission", "revoke", {
        workspaceId: entry.workspaceId,
        origin: entry.origin,
        permission: entry.permission,
      });
      if (!revokeResult.ok) {
        log.warn(`revoke failed: ${revokeResult.message}`);
        return;
      }
      void loadEntries();
    },
    [loadEntries],
  );

  // Tier A toggles — always visible.
  const tierAToggles = PERMISSION_TOGGLES.filter((t) => t.tier === "A");
  // Tier B toggles — inside a disclosure.
  const tierBToggles = PERMISSION_TOGGLES.filter((t) => t.tier === "B");

  // Group entries by workspaceId when showing all workspaces.
  const groupedEntries = (() => {
    if (!entries) return null;
    if (scopeTab === "current") {
      return [{ workspaceId: null, entries }];
    }
    const map = new Map<string, RememberedEntry[]>();
    for (const e of entries) {
      const group = map.get(e.workspaceId) ?? [];
      group.push(e);
      map.set(e.workspaceId, group);
    }
    const result: Array<{ workspaceId: string | null; entries: RememberedEntry[] }> = [];
    for (const [wsId, wsEntries] of map.entries()) {
      result.push({ workspaceId: wsId, entries: wsEntries });
    }
    return result;
  })();

  return (
    <div className="flex flex-col gap-6">
      {/* ------------------------------------------------------------------ */}
      {/* (a) Global toggle section                                            */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby="global-toggles-heading">
        <div className="flex flex-col gap-1 mb-3">
          <h2 id="global-toggles-heading" className="text-app-body-emphasis text-foreground">
            {t("browserPermissions.globalHeading")}
          </h2>
          <p className="text-app-ui-sm text-muted-foreground">
            {t("browserPermissions.globalDescription")}
          </p>
        </div>

        <div className="flex flex-col gap-1">
          {tierAToggles.map((toggle) => (
            <PermissionToggleRow
              key={toggle.key}
              toggle={toggle}
              enabled={toggle.permissions.every((p) => grants[p] === true)}
              onToggle={(enabled) => setGrant(toggle.permissions, enabled)}
            />
          ))}

          {/* Tier B — collapsible */}
          <details className="group">
            <summary
              className={cn(
                "flex items-center gap-1.5 px-1 py-1.5 cursor-pointer select-none",
                "text-app-ui-sm text-muted-foreground",
                "hover:text-foreground",
                "list-none", // remove native triangle
              )}
            >
              <span
                className="inline-block transition-transform group-open:rotate-90"
                aria-hidden="true"
              >
                ›
              </span>
              {t("browserPermissions.advanced")}
            </summary>
            <div className="flex flex-col gap-1 mt-1">
              {tierBToggles.map((toggle) => (
                <PermissionToggleRow
                  key={toggle.key}
                  toggle={toggle}
                  enabled={toggle.permissions.every((p) => grants[p] === true)}
                  onToggle={(enabled) => setGrant(toggle.permissions, enabled)}
                />
              ))}
            </div>
          </details>
        </div>
      </section>

      {/* Divider */}
      <hr className="border-t border-border" />

      {/* ------------------------------------------------------------------ */}
      {/* (b) Site memory section                                              */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby="site-memory-heading">
        <div className="flex flex-col gap-3 mb-3">
          <div className="flex flex-col gap-1">
            <h2 id="site-memory-heading" className="text-app-body-emphasis text-foreground">
              {t("browserPermissions.siteMemoryHeading")}
            </h2>
            <p className="text-app-ui-sm text-muted-foreground">
              {t("browserPermissions.siteMemoryDescription")}
            </p>
          </div>

          <SegmentedControl
            options={[
              { value: "current" as const, label: t("browserPermissions.scopeCurrent") },
              { value: "all" as const, label: t("browserPermissions.scopeAll") },
            ]}
            value={scopeTab}
            onChange={setScopeTab}
            label={t("browserPermissions.scopeLabel")}
            disabled={!activeWorkspaceId && scopeTab === "current"}
            disabledReason={t("browserPermissions.noActiveWorkspace")}
          />
        </div>

        {/* Loading skeleton */}
        {entries === null && !loadError && (
          <Skeleton label={t("browserPermissions.loadingPermissions")}>
            <SkeletonLine className="h-9" />
            <SkeletonLine className="h-9" style={{ width: "80%" }} />
            <SkeletonLine className="h-9" style={{ width: "65%" }} />
          </Skeleton>
        )}

        {/* Error state */}
        {loadError && <p className="text-app-ui-sm text-muted-foreground px-1">{loadError}</p>}

        {/* Empty state */}
        {entries !== null && !loadError && entries.length === 0 && (
          <EmptyState
            icon={<ShieldCheck className="size-8" aria-hidden="true" />}
            title={t("browserPermissions.noPermissionsTitle")}
            description={t("browserPermissions.noPermissionsDescription")}
            tone="status"
          />
        )}

        {/* Entry list */}
        {groupedEntries && entries && entries.length > 0 && (
          <div className="flex flex-col gap-4">
            {groupedEntries.map((group) => {
              const wsName =
                group.workspaceId !== null
                  ? (workspaces.find((w) => w.id === group.workspaceId)?.name ?? group.workspaceId)
                  : null;

              return (
                <div key={group.workspaceId ?? "__current__"}>
                  {/* Group header shown only in "all" scope */}
                  {scopeTab === "all" && wsName && (
                    <div className="px-1 pb-1.5">
                      <span className="text-app-label uppercase text-muted-foreground">
                        {wsName}
                      </span>
                    </div>
                  )}
                  <div className="flex flex-col gap-1">
                    {group.entries.map((entry) => (
                      <SiteEntryRow
                        key={`${entry.workspaceId}:${entry.origin}:${entry.permission}`}
                        entry={entry}
                        grants={grants}
                        onRevoke={handleRevoke}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PermissionToggleRow
// ---------------------------------------------------------------------------

interface PermissionToggleRowProps {
  toggle: (typeof PERMISSION_TOGGLES)[number];
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}

function PermissionToggleRow({ toggle, enabled, onToggle }: PermissionToggleRowProps) {
  const { t } = useTranslation("settings");
  const switchId = useId();
  const IconComponent = ICON_MAP[toggle.icon];
  const i18nKey = TOGGLE_I18N_KEY[toggle.key];
  const label = i18nKey ? t(`browserPermissions.permission.${i18nKey}.label`) : toggle.label;
  const description = i18nKey
    ? t(`browserPermissions.permission.${i18nKey}.description`)
    : toggle.description;

  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 rounded-(--radius-control) px-2 py-2",
        "hover:bg-[var(--state-hover-bg)]",
      )}
    >
      <div className="flex items-start gap-2.5 min-w-0">
        {IconComponent && (
          <IconComponent
            className="size-4 shrink-0 text-muted-foreground mt-0.5"
            aria-hidden="true"
          />
        )}
        <div className="flex flex-col gap-0.5 min-w-0">
          <label htmlFor={switchId} className="text-app-body text-foreground cursor-pointer">
            {label}
          </label>
          <p className="text-app-ui-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      <Switch
        id={switchId}
        checked={enabled}
        onCheckedChange={onToggle}
        aria-label={label}
        className="shrink-0 mt-0.5"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SiteEntryRow
// ---------------------------------------------------------------------------

interface SiteEntryRowProps {
  entry: RememberedEntry;
  grants: Record<string, boolean>;
  onRevoke: (entry: RememberedEntry) => void;
}

function SiteEntryRow({ entry, grants, onRevoke }: SiteEntryRowProps) {
  const { t } = useTranslation("settings");
  const isGloballyEnabled = grants[entry.permission] === true;

  return (
    <div
      className={cn(
        "group flex items-center justify-between gap-3 rounded-(--radius-control) px-2 py-2",
        "hover:bg-[var(--state-hover-bg)]",
        isGloballyEnabled && "opacity-50",
      )}
    >
      <div className="flex flex-col gap-1 min-w-0">
        {/* Origin */}
        <span
          className={cn(
            "text-app-body text-foreground truncate",
            isGloballyEnabled && "text-muted-foreground",
          )}
        >
          {entry.origin}
        </span>

        {/* Permission badges + global-on indicator */}
        <div className="flex flex-wrap items-center gap-1">
          <span
            className={cn(
              "inline-flex items-center rounded-(--radius-control) px-1.5 py-0.5",
              "text-app-ui-sm border border-border",
              entry.decision === "allow" ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {t(
              `browserPermissions.permissionLabel.${PERMISSION_LABEL_I18N_KEY[entry.permission] ?? "unknown"}`,
            )}
          </span>
          {isGloballyEnabled && (
            <span className="text-app-ui-sm text-muted-foreground">
              {t("browserPermissions.allowedGlobally")}
            </span>
          )}
        </div>
      </div>

      {/* Revoke button — always in layout, visible on hover/focus */}
      {/* Revoke button — layout slot always reserved; shown on group hover or focus-within */}
      <button
        type="button"
        aria-label={t("browserPermissions.deleteAriaLabel", { origin: entry.origin })}
        onClick={() => onRevoke(entry)}
        className={cn(
          "inline-flex shrink-0 items-center justify-center",
          "size-7 rounded-(--radius-control)",
          "text-muted-foreground",
          "hover:bg-[var(--state-hover-bg)] hover:text-foreground",
          "focus-visible:ring-1 focus-visible:ring-ring",
          "transition-colors",
          // Reserve slot but hide until row is hovered or button receives focus.
          "opacity-0 pointer-events-none",
          "group-hover:opacity-100 group-hover:pointer-events-auto",
          "group-focus-within:opacity-100 group-focus-within:pointer-events-auto",
        )}
      >
        <Trash2 className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
