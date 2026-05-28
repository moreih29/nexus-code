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
import { useCallback, useEffect, useRef } from "react";
import { color } from "../../../shared/design-tokens";
import { useBrowserSuspendStore } from "../../state/stores/browser-suspend";

export type DragImageSpec =
  | { kind: "self" }
  | { kind: "label"; text: string; offset?: readonly [number, number] };

export interface UseDragSourceOptions<T> {
  mime: string;
  /**
   * The payload to serialize into the MIME slot.
   * When `getPayload` is also provided, `getPayload` takes precedence and
   * `payload` is used only as a stable identity for the `useCallback` dep.
   */
  payload: T;
  /**
   * Optional: called at dragstart time to produce the actual payload that
   * will be serialized. Use when the payload must reflect runtime state (e.g.
   * the current multi-selection set) that should not be captured at render time.
   *
   * When omitted the static `payload` prop is used (existing behaviour).
   */
  getPayload?: () => T;
  /**
   * Static drag image spec, or a function that is called at dragstart time to
   * produce the spec. Use the function form when the image label depends on
   * runtime state (e.g. "3 items" vs the filename for multi-select DnD).
   */
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
  getPayload,
  dragImage,
  effectAllowed = "move",
}: UseDragSourceOptions<T>): UseDragSourceResult {
  // Holds the release callback for the currently-active suspend claim, if any.
  //
  // Stored in a ref (rather than a closure-local variable) so the unmount
  // cleanup below can release a stale claim when the source element
  // disappears mid-drag.  This is the common case during drag-to-split:
  // the dragged TabItem moves from the source leaf's tab-bar to the
  // destination leaf's tab-bar, which unmounts the source React node
  // before the OS dispatches `dragend` to it.  Without unmount cleanup the
  // suspend claim was held forever and every browser tab in the app stayed
  // setVisible(false).
  const releaseRef = useRef<(() => void) | null>(null);

  const releaseClaim = useCallback(() => {
    releaseRef.current?.();
    releaseRef.current = null;
  }, []);

  const onDragStart = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      if (!e.dataTransfer) return;

      e.dataTransfer.effectAllowed = effectAllowed;
      // Resolve payload: prefer getPayload() (runtime) over static payload.
      const actualPayload = getPayload ? getPayload() : payload;
      e.dataTransfer.setData(mime, JSON.stringify(actualPayload));

      // Resolve drag image: support function form for dynamic labels.
      const resolvedDragImage = typeof dragImage === "function" ? dragImage() : dragImage;

      if (resolvedDragImage.kind === "self") {
        // Use the source element directly — VSCode anchors at (0, 0) so the
        // cursor sits at the top-left of the dragged element, leaving room
        // for drop-border feedback on the destination.
        e.dataTransfer.setDragImage(e.currentTarget, 0, 0);
      } else {
        const offset = resolvedDragImage.offset ?? [-10, -10];
        applyTextDragImage(e, resolvedDragImage.text, offset);
      }

      // Browser-overlay suspend.  Runs in React's bubble-phase handler so
      // `setData` above has already populated the MIME types by the time
      // the suspend kicks in.  See commit history for the capture-phase
      // race that motivates the bubble-phase placement.
      //
      // `captureSnapshot: false` because a drag needs the view hidden
      // immediately for drop targets to receive `dragover` — the 30-100ms
      // capturePage round-trip would lag the drag noticeably.  Drop
      // indicators paint over the briefly-grey area within one frame.
      //
      // Defensively release any prior stranded claim (shouldn't normally
      // happen since dragstart implies the previous drag has ended).
      releaseClaim();
      releaseRef.current = useBrowserSuspendStore.getState().claim({ captureSnapshot: false });

      // Pair with a one-shot document `dragend` — the standard path when
      // the source element is still in the DOM at drop time.
      const onDragEnd = () => {
        releaseClaim();
        document.removeEventListener("dragend", onDragEnd);
      };
      document.addEventListener("dragend", onDragEnd);
    },
    [mime, payload, getPayload, dragImage, effectAllowed, releaseClaim],
  );

  // Unmount safety net.  If the source React node is removed mid-drag —
  // e.g. drag-to-split moves a TabItem to a new leaf's tab-bar, unmounting
  // the original — the OS does not always dispatch `dragend` on a detached
  // element, and the document-level listener above never fires.  Release
  // here as a last resort.
  useEffect(() => {
    return releaseClaim;
  }, [releaseClaim]);

  return { onDragStart };
}
