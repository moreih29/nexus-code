// src/renderer/components/settings/restart-banner.tsx — Restart required banner.
//
// Shown when useWindowOpacityStore.isDirty() is true and the user has not
// dismissed it in this session. Resets automatically when isDirty becomes
// false (i.e. user restored the boot value).
//
// Design seal: feedback info pattern — border-border bg-muted inline info banner.
// radius-raised (6px), text-app-ui-sm, Info icon size-3.
// role=status aria-live=polite aria-atomic=true.

import { Info } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/utils/cn";
import { useAppLifecycleStore } from "../../state/stores/app-lifecycle";
import { useWindowOpacityStore } from "../../state/stores/window-opacity";
import { Button } from "../ui/button";

export function RestartBanner() {
  const isDirty = useWindowOpacityStore((s) => s.isDirty());
  const requestRestart = useAppLifecycleStore((s) => s.requestRestart);

  // Local dismissed flag — reset whenever isDirty flips back to false.
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!isDirty) {
      setDismissed(false);
    }
  }, [isDirty]);

  const visible = isDirty && !dismissed;

  if (!visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={cn(
        "mt-3 flex flex-col gap-2 rounded-(--radius-raised) border border-border bg-muted px-3 py-2",
      )}
    >
      <div className="flex items-start gap-2">
        <Info className="mt-0.5 size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p className="text-app-ui-sm text-foreground">투명도 변경은 다음 실행 시 적용됩니다.</p>
      </div>
      <div className="flex items-center justify-end gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2"
          onClick={() => setDismissed(true)}
        >
          Keep working
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          className="h-6 px-2"
          onClick={() => void requestRestart("window-opacity-change")}
        >
          Restart now
        </Button>
      </div>
    </div>
  );
}
