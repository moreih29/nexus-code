import {
  Bell,
  Clipboard,
  Clock,
  ExternalLink,
  FolderOpen,
  LayoutGrid,
  Lock,
  type LucideProps,
  MapPin,
  Maximize,
  MonitorUp,
  Music,
  ShieldCheck,
  Video,
  Volume2,
} from "lucide-react";
import { Dialog as RadixDialog } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserPermissionKind } from "../../../shared/security/browser-permissions";
import { createListenerBus } from "../../../shared/util/listener-bus";
import { ipcCallResult } from "../../ipc/client";
import { useBrowserSuspendStore } from "../../state/stores/browser-suspend";
import { Button } from "./button";
import { Checkbox } from "./checkbox";
import { Dialog } from "./dialog";

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

const MOUNT_CLICK_GRACE_MS = 120;

export interface PermissionPromptPayload {
  promptId: string;
  workspaceId: string;
  origin: string;
  permissions: BrowserPermissionKind[];
}

interface PendingPrompt extends PermissionPromptPayload {}

let queue: PendingPrompt[] = [];
const bus = createListenerBus();

function getActive(): PendingPrompt | null {
  return queue[0] ?? null;
}

export function showPermissionPrompt(payload: PermissionPromptPayload): void {
  queue.push({ ...payload });
  bus.notify();
}

function dequeueActive(): void {
  queue = queue.slice(1);
  bus.notify();
}

export function dismissPermissionPrompt(promptId: string): void {
  const next = queue.filter((prompt) => prompt.promptId !== promptId);
  if (next.length === queue.length) return;
  queue = next;
  bus.notify();
}

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

function resolvePermissionIcon(permissions: BrowserPermissionKind[]): IconComponent {
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

interface PermissionPromptModalProps {
  prompt: PendingPrompt;
  onDone: () => void;
}

function PermissionPromptModal({ prompt, onDone }: PermissionPromptModalProps): React.JSX.Element {
  const { t } = useTranslation("settings");
  const [remember, setRemember] = useState(true);
  const mountAtRef = useRef<number>(0);

  useEffect(() => {
    const release = useBrowserSuspendStore.getState().claim({ captureSnapshot: true });
    return release;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new prompt is the trigger; it is not read.
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
    void ipcCallResult("browserPermission", "cancel", {
      promptId: prompt.promptId,
    });
    onDone();
  };

  const Icon = resolvePermissionIcon(prompt.permissions);
  const labels = prompt.permissions.map((p) =>
    t(`browserPermissions.permissionLabel.${PERMISSION_LABEL_I18N_KEY[p] ?? "unknown"}`),
  );
  const labelsText = labels.join(", ");

  return (
    <Dialog open onOpenChange={handleOpenChange} size="sm" aria-describedby={undefined}>
      <RadixDialog.Title className="sr-only">{t("permissionPrompt.srTitle")}</RadixDialog.Title>

      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0 text-muted-foreground">
          <Icon className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-app-body-emphasis text-foreground break-all">{prompt.origin}</p>
          <p className="mt-0.5 text-app-ui-sm text-muted-foreground">
            {t("permissionPrompt.requesting")}
          </p>
        </div>
      </div>

      <div className="mt-3">
        <p className="text-app-body text-foreground font-medium">{labelsText}</p>
        <p className="mt-1 text-app-ui-sm text-muted-foreground">
          {prompt.permissions.length > 1
            ? t("permissionPrompt.allowOrBlockMany")
            : t("permissionPrompt.allowOrBlockOne")}
        </p>
      </div>

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
          {t("permissionPrompt.remember")}
        </label>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={handleBlock}>
          {t("permissionPrompt.block")}
        </Button>
        <Button variant="default" size="sm" onClick={handleAllow}>
          {t("permissionPrompt.allow")}
        </Button>
      </div>

      <p className="mt-3 text-app-micro text-muted-foreground">{t("permissionPrompt.escHint")}</p>
    </Dialog>
  );
}

export function PermissionPromptRoot(): React.JSX.Element {
  const [active, setActive] = useState<PendingPrompt | null>(getActive());

  useEffect(() => {
    return bus.subscribe(() => setActive(getActive()));
  }, []);

  if (active === null) {
    return <></>;
  }

  return <PermissionPromptModal key={active.promptId} prompt={active} onDone={dequeueActive} />;
}
