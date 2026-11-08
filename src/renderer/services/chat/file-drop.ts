/**
 * Files dragged onto a chat from outside the app: whether they are over it,
 * and what is let go there. A drag enters and leaves each child it crosses,
 * so the chat counts its way in and out, and takes the drag for gone once
 * it leaves the chat's box or turns up elsewhere in the app.
 */

/** Whether a drag carries files from outside the app; the app's own drags carry its own types. */
export function carriesFiles(data: Pick<DataTransfer, "types"> | null | undefined): boolean {
  return !!data && Array.from(data.types).includes("Files");
}

export interface FileDropHandlers {
  /** Files came over the chat, or are no longer over it. */
  over(over: boolean): void;
  /** Files were let go on the chat. */
  drop(files: File[]): void;
}

/** What `watchFileDrop` needs of the element files are dropped on. */
export interface DropArea extends EventTarget {
  contains(other: unknown): boolean;
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number };
}

type Drag = Event & {
  dataTransfer?: DataTransfer | null;
  clientX?: number;
  clientY?: number;
};

/** Follows files dragged over `area`; returns what stops following. */
export function watchFileDrop(
  area: DropArea,
  on: FileDropHandlers,
  doc: EventTarget = document,
): () => void {
  let depth = 0;
  const gone = () => {
    if (depth === 0) return;
    depth = 0;
    on.over(false);
  };
  const outside = (e: Drag) => {
    const { clientX: x, clientY: y } = e;
    if (x === undefined || y === undefined) return false;
    const box = area.getBoundingClientRect();
    return x <= box.left || x >= box.right || y <= box.top || y >= box.bottom;
  };

  const enter = (e: Drag) => {
    if (!carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    depth += 1;
    if (depth === 1) on.over(true);
  };
  const over = (e: Drag) => {
    if (!carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    if (depth === 0) {
      depth = 1;
      on.over(true);
    }
  };
  const leave = (e: Drag) => {
    if (!carriesFiles(e.dataTransfer) || depth === 0) return;
    depth -= 1;
    if (depth === 0) on.over(false);
    else if (outside(e)) gone();
  };
  const drop = (e: Drag) => {
    if (!carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    gone();
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) on.drop(files);
  };
  // A child taken away under the drag never says it was left: the drag is
  // gone once it is over another part of the app, let go, or called off,
  // and surely once the mouse moves again, which it does not mid-drag.
  const elsewhere = (e: Drag) => {
    if (!area.contains(e.target)) gone();
  };

  const own: [string, (e: Drag) => void][] = [
    ["dragenter", enter],
    ["dragover", over],
    ["dragleave", leave],
    ["drop", drop],
  ];
  const app: [string, (e: Drag) => void][] = [
    ["dragover", elsewhere],
    ["drop", gone],
    ["dragend", gone],
    ["mousemove", gone],
  ];
  for (const [type, fn] of own) area.addEventListener(type, fn as EventListener);
  for (const [type, fn] of app) doc.addEventListener(type, fn as EventListener, true);
  return () => {
    for (const [type, fn] of own) area.removeEventListener(type, fn as EventListener);
    for (const [type, fn] of app) doc.removeEventListener(type, fn as EventListener, true);
    gone();
  };
}
