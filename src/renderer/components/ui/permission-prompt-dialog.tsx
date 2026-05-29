/**
 * PermissionPromptDialog — browser permission request modal.
 *
 * Imperative API: callers invoke `showPermissionPrompt(payload)` when main
 * broadcasts a `browserPermission:prompt` event. The component is rendered
 * once at App level via PermissionPromptRoot; there is no per-callsite Dialog.
 *
 * Concurrency: prompts may queue back-to-back. A second showPermissionPrompt()
 * while one is open queues and is shown after the first resolves — same
 * pattern as ConfirmDialogRoot.
 *
 * Browser suspend: the modal claims useBrowserSuspendStore on mount so the
 * native WebContentsView is hidden (with snapshot) while the prompt is visible.
 * The auto-suspend MutationObserver in browser-suspend-auto.ts also fires, but
 * the explicit claim here ensures the view is hidden even before the Radix
 * portal element appears in the DOM.
 */

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
  Video,
  Volume2,
  type LucideProps,
} from "lucide-react";
import { Dialog as RadixDialog } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import type { BrowserPermissionKind } from "../../../shared/security/browser-permissions";
import { permissionLabel } from "../../../shared/security/browser-permissions";
import { ipcCallResult } from "../../ipc/client";
import { useBrowserSuspendStore } from "../../state/stores/browser-suspend";
import { createListenerBus } from "../../../shared/util/listener-bus";
import { Button } from "./button";
import { Checkbox } from "./checkbox";
import { Dialog } from "./dialog";

// ---------------------------------------------------------------------------
// Grace-window (same rationale as ConfirmDialogRoot — see that module)
// ---------------------------------------------------------------------------

const MOUNT_CLICK_GRACE_MS = 120;

// ---------------------------------------------------------------------------
// Queue + bus
// ---------------------------------------------------------------------------

export interface PermissionPromptPayload {
  promptId: string;
  workspaceId: string;
  origin: string;
  permissions: BrowserPermissionKind[];
}

interface PendingPrompt extends PermissionPromptPayload {
  // no extra resolve needed — we respond via IPC directly
}

let queue: PendingPrompt[] = [];
const bus = createListenerBus();

function getActive(): PendingPrompt | null {
  return queue[0] ?? null;
}

/**
 * Imperative entry point. Enqueues a permission prompt. The modal is shown
 * when it reaches the head of the queue.
 */
export function showPermissionPrompt(payload: PermissionPromptPayload): void {
  queue.push({ ...payload });
  bus.notify();
}

function dequeueActive(): void {
  queue = queue.slice(1);
  bus.notify();
}

// ---------------------------------------------------------------------------
// Icon mapping — PERMISSION_TOGGLES.icon → lucide component
// ---------------------------------------------------------------------------

type IconComponent = React.ForwardRefExoticComponent<
  Omit<LucideProps, "ref"> & React.RefAttributes<SVGSVGElement>
>;

const ICON_MAP: Record<string, IconComponent> = {
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
  Video,
  Volume2,
};

/**
 * Returns the primary lucide icon for a list of permissions.
 * Uses the first permission's icon from PERMISSION_TOGGLES, falling back to
 * ShieldCheck for unknown or unmatched permissions.
 */
function resolvePermissionIcon(permissions: BrowserPermissionKind[]): IconComponent {
  // Build a simple per-kind icon map from PERMISSION_TOGGLES icon field.
  // Import at module level would create a circular dep risk; inline map is safe.
  const KIND_ICON: Record<string, string> = {
    media: "Video",
    geolocation: "MapPin",
    notifications: "Bell",
    "display-capture": "MonitorUp",
    "clipboard-read": "Clipboard",
    openExternal: "ExternalLink",
    fileSystem: "FolderOpen",
    midi: "Music",
    midiSysex: "Music",
    fullscreen: "Maximize",
    pointerLock: "Lock",
    keyboardLock: "Lock",
    "idle-detection": "Clock",
    "window-management": "LayoutGrid",
    "speaker-selection": "Volume2",
    mediaKeySystem: "ShieldCheck",
  };

  const first = permissions[0];
  const iconName = first !== undefined ? KIND_ICON[first] : undefined;
  return (iconName !== undefined ? ICON_MAP[iconName] : undefined) ?? ShieldCheck;
}

// ---------------------------------------------------------------------------
// PermissionPromptModal — inner component that owns the suspend claim
// ---------------------------------------------------------------------------

interface PermissionPromptModalProps {
  prompt: PendingPrompt;
  onDone: () => void;
}

function PermissionPromptModal({ prompt, onDone }: PermissionPromptModalProps): React.JSX.Element {
  const [remember, setRemember] = useState(true);
  const mountAtRef = useRef<number>(0);

  // Explicit suspend claim — ensures native view is hidden before the Radix
  // portal appears. Released on unmount.
  useEffect(() => {
    const release = useBrowserSuspendStore.getState().claim({ captureSnapshot: true });
    return release;
  }, []);

  // Re-arm grace window on every new prompt.
  useEffect(() => {
    mountAtRef.current = performance.now();
  }, [prompt]);

  const isResidualKeyboardClick = (e: React.MouseEvent): boolean => {
    if (e.detail !== 0) return false;
    return performance.now() - mountAtRef.current < MOUNT_CLICK_GRACE_MS;
  };

  const handleAllow = (e: React.MouseEvent): void => {
    if (isResidualKeyboardClick(e)) {
      e.preventDefault();
      return;
    }
    void ipcCallResult("browserPermission", "respond", {
      promptId: prompt.promptId,
      decision: "allow",
      remember,
    });
    onDone();
  };

  const handleBlock = (e: React.MouseEvent): void => {
    if (isResidualKeyboardClick(e)) {
      e.preventDefault();
      return;
    }
    void ipcCallResult("browserPermission", "respond", {
      promptId: prompt.promptId,
      decision: "block",
      remember,
    });
    onDone();
  };

  const handleOpenChange = (next: boolean): void => {
    if (next) return;
    // ESC or outside click — one-time cancel (no remembered rule).
    void ipcCallResult("browserPermission", "cancel", {
      promptId: prompt.promptId,
    });
    onDone();
  };

  const Icon = resolvePermissionIcon(prompt.permissions);
  const labels = prompt.permissions.map((p) => permissionLabel(p));
  const labelsText = labels.join(", ");

  return (
    <Dialog open onOpenChange={handleOpenChange} size="sm" aria-describedby={undefined}>
      <RadixDialog.Title className="sr-only">브라우저 권한 요청</RadixDialog.Title>

      {/* Header: icon + origin */}
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0 text-muted-foreground">
          <Icon className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-app-body-emphasis text-foreground break-all">
            {prompt.origin}
          </p>
          <p className="mt-0.5 text-app-ui-sm text-muted-foreground">
            이(가) 다음을 요청합니다
          </p>
        </div>
      </div>

      {/* Permission labels */}
      <div className="mt-3">
        <p className="text-app-body text-foreground font-medium">{labelsText}</p>
        <p className="mt-1 text-app-ui-sm text-muted-foreground">
          {prompt.permissions.length > 1
            ? "위 권한들에 대한 접근을 허용하거나 차단합니다."
            : "이 권한에 대한 접근을 허용하거나 차단합니다."}
        </p>
      </div>

      {/* Remember checkbox */}
      <div className="mt-4 flex items-center gap-2">
        <Checkbox
          id="permission-remember"
          checked={remember}
          onCheckedChange={(checked) => setRemember(checked === true)}
        />
        <label
          htmlFor="permission-remember"
          className="text-app-ui-sm text-muted-foreground cursor-pointer select-none"
        >
          이 워크스페이스에서 이 사이트를 기억
        </label>
      </div>

      {/* Action buttons */}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={handleBlock}>
          차단
        </Button>
        <Button variant="default" size="sm" onClick={handleAllow} autoFocus>
          허용
        </Button>
      </div>

      {/* Micro hint */}
      <p className="mt-3 text-app-micro text-muted-foreground">
        ESC·바깥 클릭 → 이번만 차단
      </p>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// PermissionPromptRoot — mount once at App level
// ---------------------------------------------------------------------------

/**
 * Mount once at App level (in GlobalRoots). Reads the head of the prompt queue
 * and renders the active permission request dialog.
 */
export function PermissionPromptRoot(): React.JSX.Element {
  const [active, setActive] = useState<PendingPrompt | null>(getActive());

  useEffect(() => {
    return bus.subscribe(() => setActive(getActive()));
  }, []);

  if (active === null) {
    return <></>;
  }

  return (
    <PermissionPromptModal
      key={active.promptId}
      prompt={active}
      onDone={dequeueActive}
    />
  );
}
