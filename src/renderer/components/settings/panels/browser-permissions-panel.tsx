// src/renderer/components/settings/panels/browser-permissions-panel.tsx
//
// Browser Permissions settings panel.
//
// (a) Global toggle section — lets the user pre-approve permission kinds for
//     all workspaces.  Tier A items are always visible; Tier B items are
//     collapsed under a "고급" disclosure.
//
// (b) Site memory section — lists previously remembered per-origin permission
//     decisions with a segmented-control filter (current workspace / all).
//     Each row shows the origin, permission badges, and a revoke button.
//
// Design: semantic tokens only (no hex/rgba/oklch literals, no box-shadow).
// Korean microcopy throughout.

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
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ipcCallResult } from "../../../ipc/client";
import type { BrowserPermissionKind } from "../../../../shared/security/browser-permissions";
import {
  PERMISSION_TOGGLES,
  permissionLabel,
} from "../../../../shared/security/browser-permissions";
import { useBrowserPermissionsStore } from "../../../state/stores/browser-permissions";
import { useActiveStore } from "../../../state/stores/active";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { showConfirmDialog } from "../../ui/confirm-dialog";
import { EmptyState } from "../../ui/empty-state";
import { Skeleton, SkeletonLine } from "../../ui/skeleton";
import { Switch } from "../../ui/switch";
import { SegmentedControl } from "../segmented-control";
import { cn } from "@/utils/cn";

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
  const grants = useBrowserPermissionsStore((s) => s.grants);
  const setGrant = useBrowserPermissionsStore((s) => s.setGrant);

  const activeWorkspaceId = useActiveStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspacesStore((s) => s.workspaces);

  const [scopeTab, setScopeTab] = useState<ScopeTab>("current");
  const [entries, setEntries] = useState<RememberedEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fetchRef = useRef(0);

  // Load remembered entries whenever the scope tab or active workspace changes.
  const loadEntries = useCallback(async () => {
    const token = ++fetchRef.current;
    setEntries(null);
    setLoadError(null);

    const workspaceId =
      scopeTab === "current" && activeWorkspaceId ? activeWorkspaceId : undefined;

    const result = await ipcCallResult("browserPermission", "listRemembered", {
      workspaceId,
    });

    if (token !== fetchRef.current) return; // stale

    if (!result.ok) {
      setLoadError(result.message ?? "목록을 불러오지 못했습니다.");
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
        title: "사이트 권한 기억 삭제",
        description:
          "이 사이트의 기억을 삭제하면 다음 방문 시 다시 묻습니다.",
        confirmLabel: "삭제",
        cancelLabel: "취소",
        variant: "destructive",
      });
      if (!confirmed) return;

      const revokeResult = await ipcCallResult("browserPermission", "revoke", {
        workspaceId: entry.workspaceId,
        origin: entry.origin,
        permission: entry.permission,
      });
      if (!revokeResult.ok) {
        console.warn("[browser-permissions] revoke failed", revokeResult.message);
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
          <h2
            id="global-toggles-heading"
            className="text-app-body-emphasis text-foreground"
          >
            전역 권한 허용
          </h2>
          <p className="text-app-ui-sm text-muted-foreground">
            켜면 모든 워크스페이스에서 자동 허용됩니다. 모두 기본 꺼짐.
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
              고급
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
            <h2
              id="site-memory-heading"
              className="text-app-body-emphasis text-foreground"
            >
              사이트별 기억된 권한
            </h2>
            <p className="text-app-ui-sm text-muted-foreground">
              사이트가 권한을 요청할 때 기억하도록 선택한 결정 목록입니다.
            </p>
          </div>

          <SegmentedControl
            options={[
              { value: "current" as const, label: "현재 워크스페이스" },
              { value: "all" as const, label: "모든 워크스페이스" },
            ]}
            value={scopeTab}
            onChange={setScopeTab}
            label="사이트 기억 범위"
            disabled={!activeWorkspaceId && scopeTab === "current"}
            disabledReason="활성 워크스페이스가 없습니다."
          />
        </div>

        {/* Loading skeleton */}
        {entries === null && !loadError && (
          <Skeleton label="기억된 권한 목록 불러오는 중">
            <SkeletonLine className="h-9" />
            <SkeletonLine className="h-9" style={{ width: "80%" }} />
            <SkeletonLine className="h-9" style={{ width: "65%" }} />
          </Skeleton>
        )}

        {/* Error state */}
        {loadError && (
          <p className="text-app-ui-sm text-muted-foreground px-1">{loadError}</p>
        )}

        {/* Empty state */}
        {entries !== null && !loadError && entries.length === 0 && (
          <EmptyState
            icon={<ShieldCheck className="size-8" aria-hidden="true" />}
            title="기억된 권한 없음"
            description="사이트 권한을 허용하거나 거부할 때 '기억하기'를 선택하면 여기에 표시됩니다."
            tone="status"
          />
        )}

        {/* Entry list */}
        {groupedEntries && entries && entries.length > 0 && (
          <div className="flex flex-col gap-4">
            {groupedEntries.map((group) => {
              const wsName =
                group.workspaceId !== null
                  ? (workspaces.find((w) => w.id === group.workspaceId)?.name ??
                    group.workspaceId)
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
  const switchId = useId();
  const IconComponent = ICON_MAP[toggle.icon];

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
          <label
            htmlFor={switchId}
            className="text-app-body text-foreground cursor-pointer"
          >
            {toggle.label}
          </label>
          <p className="text-app-ui-sm text-muted-foreground">
            {toggle.description}
          </p>
        </div>
      </div>
      <Switch
        id={switchId}
        checked={enabled}
        onCheckedChange={onToggle}
        aria-label={toggle.label}
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
              entry.decision === "allow"
                ? "text-foreground"
                : "text-muted-foreground",
            )}
          >
            {permissionLabel(entry.permission)}
          </span>
          {isGloballyEnabled && (
            <span className="text-app-ui-sm text-muted-foreground">
              전역 허용 중
            </span>
          )}
        </div>
      </div>

      {/* Revoke button — always in layout, visible on hover/focus */}
      {/* Revoke button — layout slot always reserved; shown on group hover or focus-within */}
      <button
        type="button"
        aria-label={`${entry.origin} 기억 삭제`}
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
