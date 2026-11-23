import { useCallback, useEffect, useRef } from "react";
import { color } from "../../../shared/design-tokens";
import { useBrowserSuspendStore } from "../../state/stores/browser-suspend";
import { beginDragInFlight } from "../../utils/drag-in-flight";

export type DragImageSpec =
  | { kind: "self" }
  | { kind: "label"; text: string; offset?: readonly [number, number] };

export interface UseDragSourceOptions<T> {
  mime: string;
  payload: T;
  getPayload?: () => T;
  dragImage: DragImageSpec | (() => DragImageSpec);
  effectAllowed?: DataTransfer["effectAllowed"];
}

export interface UseDragSourceResult {
  onDragStart: (e: React.DragEvent<HTMLElement>) => void;
}

const DRAG_LABEL_CLASS = "nexus-drag-label";

function applyTextDragImage(
  e: React.DragEvent<HTMLElement>,
  text: string,
  offset: readonly [number, number],
): void {
  if (!e.dataTransfer) return;

  const label = document.createElement("div");
  label.className = DRAG_LABEL_CLASS;
  label.textContent = text;
  label.style.position = "fixed";
  label.style.top = "-1000px";
  label.style.left = "-1000px";
  label.style.padding = "4px 8px";
  label.style.borderRadius = "4px";
  label.style.font = "12px system-ui, sans-serif";
  label.style.background = `var(--popover, ${color.mutedSurfaceHex})`;
  label.style.color = `var(--popover-foreground, ${color.warmParchmentHex})`;
  label.style.border = `1px solid var(--border, ${color.borderDefault})`;
  label.style.pointerEvents = "none";
  label.style.whiteSpace = "nowrap";

  document.body.appendChild(label);
  e.dataTransfer.setDragImage(label, offset[0], offset[1]);
  setTimeout(() => label.remove(), 0);
}

export function useDragSource<T>({
  mime,
  payload,
  getPayload,
  dragImage,
  effectAllowed = "move",
}: UseDragSourceOptions<T>): UseDragSourceResult {
  const releaseRef = useRef<(() => void) | null>(null);

  const releaseClaim = useCallback(() => {
    releaseRef.current?.();
    releaseRef.current = null;
  }, []);

  const onDragStart = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      if (!e.dataTransfer) return;

      e.dataTransfer.effectAllowed = effectAllowed;
      const actualPayload = getPayload ? getPayload() : payload;
      e.dataTransfer.setData(mime, JSON.stringify(actualPayload));

      const resolvedDragImage = typeof dragImage === "function" ? dragImage() : dragImage;

      if (resolvedDragImage.kind === "self") {
        e.dataTransfer.setDragImage(e.currentTarget, 0, 0);
      } else {
        const offset = resolvedDragImage.offset ?? [-10, -10];
        applyTextDragImage(e, resolvedDragImage.text, offset);
      }

      releaseClaim();
      releaseRef.current = useBrowserSuspendStore.getState().claim({ captureSnapshot: false });

      const endFlight = beginDragInFlight();
      const onDragEnd = () => {
        endFlight();
        releaseClaim();
        document.removeEventListener("dragend", onDragEnd);
      };
      document.addEventListener("dragend", onDragEnd);
    },
    [mime, payload, getPayload, dragImage, effectAllowed, releaseClaim],
  );

  useEffect(() => {
    return releaseClaim;
  }, [releaseClaim]);

  return { onDragStart };
}
