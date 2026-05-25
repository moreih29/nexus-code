/**
 * Generic dragstart wrapper used by tab-bar and file-tree.
 *
 * Owns: dataTransfer setData (MIME + JSON payload), effectAllowed, and the
 *       setDragImage call (either the source DOM or a transient text label).
 * Caller owns: declaring the MIME, building the payload, choosing the drag
 *              image strategy, and wiring `draggable=true` + `onDragStart` on
 *              the element.
 *
 * The text-label drag image must outlive `setDragImage` long enough for the
 * browser to capture it, but must not stay in the DOM after that — we follow
 * VSCode's pattern of removing it on the next macrotask (setTimeout 0).
 *
 * BROWSER-OVERLAY SUSPEND
 * Because every supported drag in our app starts from this hook, the suspend
 * claim is also issued here — paired with a one-shot document `dragend`
 * listener that releases it.  This places the claim in the React
 * `onDragStart` callback, which runs in bubble phase **after** native event
 * dispatch, so it is guaranteed that `setData()` has already populated the
 * MIME types by the time the suspend kicks in.  Doing the claim from a
 * document-level capture listener would race against React and silently
 * leave the WebContentsView attached — see commit history for the bug.
 */
import { useCallback } from "react";
import { color } from "../../../shared/design-tokens";
import { useBrowserSuspendStore } from "../../state/stores/browser-suspend";

export type DragImageSpec =
  | { kind: "self" }
  | { kind: "label"; text: string; offset?: readonly [number, number] };

export interface UseDragSourceOptions<T> {
  mime: string;
  payload: T;
  dragImage: DragImageSpec;
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
  // Position offscreen so it never paints in the page; setDragImage captures
  // it from the DOM regardless of visibility, but it MUST be in the DOM at
  // the moment setDragImage is called.
  label.style.position = "fixed";
  label.style.top = "-1000px";
  label.style.left = "-1000px";
  label.style.padding = "4px 8px";
  label.style.borderRadius = "4px";
  label.style.font = "12px system-ui, sans-serif";
  // Fallbacks come from `shared/design-tokens` so the literal values match
  // the actual semantic tokens (--popover, --popover-foreground, --border).
  // Previously the fallbacks were guess-hex values (#2a2a2a / #f0f0f0 /
  // #404040) which drifted from the real palette.
  label.style.background = `var(--popover, ${color.mutedSurfaceHex})`;
  label.style.color = `var(--popover-foreground, ${color.warmParchmentHex})`;
  label.style.border = `1px solid var(--border, ${color.borderDefault})`;
  label.style.pointerEvents = "none";
  label.style.whiteSpace = "nowrap";

  document.body.appendChild(label);
  e.dataTransfer.setDragImage(label, offset[0], offset[1]);
  // Remove on next macrotask — same pattern as VSCode's applyDragImage.
  setTimeout(() => label.remove(), 0);
}

export function useDragSource<T>({
  mime,
  payload,
  dragImage,
  effectAllowed = "move",
}: UseDragSourceOptions<T>): UseDragSourceResult {
  const onDragStart = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      if (!e.dataTransfer) return;

      e.dataTransfer.effectAllowed = effectAllowed;
      e.dataTransfer.setData(mime, JSON.stringify(payload));

      if (dragImage.kind === "self") {
        // Use the source element directly — VSCode anchors at (0, 0) so the
        // cursor sits at the top-left of the dragged element, leaving room
        // for drop-border feedback on the destination.
        e.dataTransfer.setDragImage(e.currentTarget, 0, 0);
      } else {
        const offset = dragImage.offset ?? [-10, -10];
        applyTextDragImage(e, dragImage.text, offset);
      }

      // Browser-overlay suspend.  This runs in React's bubble-phase handler,
      // so the WebContentsView covering the panel is already known to be in
      // the way of any drop target — claim the suspend slot now and release
      // it on the next document `dragend`.  Bubble-phase ensures `setData`
      // above has finished and any drop-target observer can see our MIME.
      //
      // `captureSnapshot: false` because a drag needs the view hidden
      // immediately for drop targets to receive `dragover` — the 30-100ms
      // capturePage round-trip would lag the drag noticeably.  Drop
      // indicators paint over the briefly-grey area within one frame.
      const release = useBrowserSuspendStore.getState().claim({ captureSnapshot: false });
      const onDragEnd = () => {
        release();
        document.removeEventListener("dragend", onDragEnd);
      };
      // `dragend` fires on the source even when the drop is cancelled (Esc,
      // dropped outside any target, dropped in another window), so this
      // one-shot listener cannot leak the claim.
      document.addEventListener("dragend", onDragEnd);
    },
    [mime, payload, dragImage, effectAllowed],
  );

  return { onDragStart };
}
