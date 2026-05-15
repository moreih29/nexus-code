/**
 * Viewport-sized Canvas renderer for Git history lanes.
 */
import type { VirtualItem } from "@tanstack/react-virtual";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { LogEntry } from "../../../../../../shared/types/git";
import type { LaneState } from "./lane-assign";

const DEFAULT_ROW_HEIGHT_PX = 24;
const DEFAULT_LANE_WIDTH_PX = 18;
const NODE_RADIUS_PX = 4.5;
const EDGE_WIDTH_PX = 1.6;
const MERGE_NODE_STROKE_WIDTH_PX = 1.8;
const LANE_COLOR_COUNT = 8;
const MIN_CANVAS_SIZE_PX = 1;
const DEFAULT_LANE_COLORS = [
  "oklch(0.56 0.07 55)",
  "oklch(0.56 0.075 95)",
  "oklch(0.56 0.07 145)",
  "oklch(0.56 0.065 190)",
  "oklch(0.56 0.06 235)",
  "oklch(0.56 0.065 285)",
  "oklch(0.56 0.07 330)",
  "oklch(0.56 0.065 25)",
] as const;

export type GraphCanvasVisibleRow = Pick<VirtualItem, "index" | "size" | "start">;

export interface GraphCanvasVirtualizer {
  getVirtualItems: () => readonly GraphCanvasVisibleRow[];
}

export interface GraphCanvasProps {
  entries: readonly LogEntry[];
  laneState: LaneState;
  scrollElementRef: React.RefObject<HTMLElement | null>;
  virtualizer?: GraphCanvasVirtualizer;
  visibleRows?: readonly GraphCanvasVisibleRow[];
  rowHeight?: number;
  laneWidth?: number;
  width?: number;
  height?: number;
  viewportOffset?: number;
  pinToScrollOffset?: boolean;
  redrawKey?: unknown;
  className?: string;
  style?: React.CSSProperties;
}

export interface GraphDrawInputs {
  entries: readonly LogEntry[];
  laneState: LaneState;
  scrollElement: HTMLElement | null;
  virtualizer?: GraphCanvasVirtualizer;
  visibleRows?: readonly GraphCanvasVisibleRow[];
  commitIndex?: ReadonlyMap<string, number>;
  rowHeight: number;
  laneWidth: number;
  width?: number;
  height?: number;
  viewportOffset: number;
  pinToScrollOffset: boolean;
}

interface CanvasMetrics {
  cssWidth: number;
  cssHeight: number;
  scrollTop: number;
}

interface EdgeLayout {
  fromLane: number;
  toLane: number;
  fromY: number;
  toY: number;
  kind: "parent" | "merge";
}

interface PreparedRow {
  entry: LogEntry;
  lane: number;
  y: number;
}

/** Renders the visual-only Git history graph; rows keep interaction and ARIA in DOM. */
export function GraphCanvas({
  entries,
  laneState,
  scrollElementRef,
  virtualizer,
  visibleRows,
  rowHeight = DEFAULT_ROW_HEIGHT_PX,
  laneWidth = DEFAULT_LANE_WIDTH_PX,
  width,
  height,
  viewportOffset = 0,
  pinToScrollOffset = true,
  className,
  style,
}: GraphCanvasProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const commitIndex = useMemo(() => buildCommitIndex(entries), [entries]);
  const drawInputsRef = useRef<GraphDrawInputs>({
    entries,
    laneState,
    scrollElement: null,
    virtualizer,
    visibleRows,
    commitIndex,
    rowHeight,
    laneWidth,
    width,
    height,
    viewportOffset,
    pinToScrollOffset,
  });

  drawInputsRef.current = {
    entries,
    laneState,
    scrollElement: scrollElementRef.current,
    virtualizer,
    visibleRows,
    commitIndex,
    rowHeight,
    laneWidth,
    width,
    height,
    viewportOffset,
    pinToScrollOffset,
  };

  /** Batches scroll and virtualizer churn into one Canvas redraw per animation frame. */
  const scheduleRedraw = useCallback((): void => {
    if (animationFrameRef.current !== null) return;
    animationFrameRef.current = window.requestAnimationFrame(() => {
      animationFrameRef.current = null;
      const canvas = canvasRef.current;
      if (!canvas) return;
      drawGraphCanvas(canvas, {
        ...drawInputsRef.current,
        scrollElement: scrollElementRef.current,
      });
    });
  }, [scrollElementRef]);

  useEffect(() => {
    scheduleRedraw();
  });

  useEffect(() => {
    const scrollElement = scrollElementRef.current;
    if (!scrollElement || typeof scrollElement.addEventListener !== "function") return undefined;

    const handleScroll = () => scheduleRedraw();
    scrollElement.addEventListener("scroll", handleScroll, { passive: true });

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => scheduleRedraw());
    resizeObserver?.observe(scrollElement);

    return () => {
      scrollElement.removeEventListener("scroll", handleScroll);
      resizeObserver?.disconnect();
    };
  }, [scrollElementRef, scheduleRedraw]);

  useEffect(
    () => () => {
      if (animationFrameRef.current === null) return;
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    },
    [],
  );

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none", ...style }}
    />
  );
}

/** Paints the current visible Git graph window into an already-mounted Canvas. */
export function drawGraphCanvas(canvas: HTMLCanvasElement, inputs: GraphDrawInputs): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const metrics = prepareCanvas(canvas, inputs);
  ctx.clearRect(0, 0, metrics.cssWidth, metrics.cssHeight);
  if (metrics.cssWidth <= 0 || metrics.cssHeight <= 0) return;

  const visibleRows = resolveVisibleRows(inputs);
  const visibleRange = resolveVisibleIndexRange(visibleRows, inputs.entries.length);
  if (!visibleRange) return;

  const laneColors = readLaneColors(canvas);
  const rowByIndex = mapVisibleRows(visibleRows);
  const edges = prepareVisibleEdges(inputs, rowByIndex, visibleRange, metrics);
  const rows = prepareVisibleRows(inputs, rowByIndex, metrics);

  drawEdges(ctx, edges, laneColors, inputs.laneWidth, inputs.rowHeight);
  drawNodes(ctx, rows, laneColors, inputs.laneWidth);
}

/** Builds a fast SHA-to-row lookup for edge endpoint resolution during redraws. */
function buildCommitIndex(entries: readonly LogEntry[]): ReadonlyMap<string, number> {
  const index = new Map<string, number>();
  for (let rowIndex = 0; rowIndex < entries.length; rowIndex += 1) {
    index.set(entries[rowIndex].sha, rowIndex);
  }
  return index;
}

/** Synchronizes CSS pixels, backing-store pixels, DPR transform, and pinning. */
function prepareCanvas(canvas: HTMLCanvasElement, inputs: GraphDrawInputs): CanvasMetrics {
  const scrollTop = getScrollTop(inputs.scrollElement) + inputs.viewportOffset;
  const cssWidth = Math.max(MIN_CANVAS_SIZE_PX, inputs.width ?? measureGraphWidth(inputs));
  const cssHeight = Math.max(
    MIN_CANVAS_SIZE_PX,
    inputs.height ?? inputs.scrollElement?.clientHeight ?? DEFAULT_ROW_HEIGHT_PX,
  );
  const dpr = resolveDevicePixelRatio(canvas);
  const pixelWidth = Math.max(MIN_CANVAS_SIZE_PX, Math.round(cssWidth * dpr));
  const pixelHeight = Math.max(MIN_CANVAS_SIZE_PX, Math.round(cssHeight * dpr));

  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.style.transform = inputs.pinToScrollOffset ? `translateY(${scrollTop}px)` : "";

  const ctx = canvas.getContext("2d");
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);

  return { cssWidth, cssHeight, scrollTop };
}

/** Returns the current scroll offset without assuming the virtualizer has rendered yet. */
function getScrollTop(scrollElement: HTMLElement | null): number {
  if (!scrollElement) return 0;
  return Math.max(0, scrollElement.scrollTop);
}

/** Measures enough horizontal room for every referenced lane. */
function measureGraphWidth(inputs: GraphDrawInputs): number {
  const laneCount = Math.max(1, getMaxLaneIndex(inputs.laneState) + 1);
  return laneCount * inputs.laneWidth;
}

/** Finds the rightmost lane referenced by commits, open lanes, or edges. */
function getMaxLaneIndex(laneState: LaneState): number {
  let maxLane = laneState.openLanes.length - 1;
  for (const lane of laneState.laneByCommit.values()) {
    maxLane = Math.max(maxLane, lane);
  }
  for (const edge of laneState.edges) {
    maxLane = Math.max(maxLane, edge.fromLane, edge.toLane);
  }
  return maxLane;
}

/** Reads the browser DPR at paint time so DPR 1/2/3 all use matching backing stores. */
function resolveDevicePixelRatio(canvas: HTMLCanvasElement): number {
  const view = canvas.ownerDocument.defaultView;
  const fallbackDpr = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  const dpr = view?.devicePixelRatio ?? fallbackDpr ?? 1;
  return Number.isFinite(dpr) ? Math.max(1, dpr) : 1;
}

/** Resolves either direct virtual rows or a virtualizer-provided visible window. */
function resolveVisibleRows(inputs: GraphDrawInputs): readonly GraphCanvasVisibleRow[] {
  return inputs.visibleRows ?? inputs.virtualizer?.getVirtualItems() ?? [];
}

/** Records the visible index window, including overscan rows supplied by the virtualizer. */
function resolveVisibleIndexRange(
  visibleRows: readonly GraphCanvasVisibleRow[],
  entryCount: number,
): { first: number; last: number } | null {
  if (visibleRows.length === 0 || entryCount === 0) return null;

  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const row of visibleRows) {
    if (row.index < 0 || row.index >= entryCount) continue;
    first = Math.min(first, row.index);
    last = Math.max(last, row.index);
  }

  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  return { first, last };
}

/** Keeps exact virtual row geometry available for visible rows. */
function mapVisibleRows(
  visibleRows: readonly GraphCanvasVisibleRow[],
): ReadonlyMap<number, GraphCanvasVisibleRow> {
  const rows = new Map<number, GraphCanvasVisibleRow>();
  for (const row of visibleRows) rows.set(row.index, row);
  return rows;
}

/** Converts an entry row index into viewport-local Canvas coordinates. */
function getRowCenterY(
  index: number,
  rowByIndex: ReadonlyMap<number, GraphCanvasVisibleRow>,
  rowHeight: number,
  scrollTop: number,
): number {
  const virtualRow = rowByIndex.get(index);
  if (virtualRow) return virtualRow.start - scrollTop + virtualRow.size / 2;
  return index * rowHeight - scrollTop + rowHeight / 2;
}

/** Prepares only graph edges whose row span intersects the visible virtual window. */
function prepareVisibleEdges(
  inputs: GraphDrawInputs,
  rowByIndex: ReadonlyMap<number, GraphCanvasVisibleRow>,
  visibleRange: { first: number; last: number },
  metrics: CanvasMetrics,
): EdgeLayout[] {
  const edges: EdgeLayout[] = [];
  const commitIndex = inputs.commitIndex ?? buildCommitIndex(inputs.entries);
  const minIndex = Math.max(0, visibleRange.first - 1);
  const maxIndex = Math.min(inputs.entries.length, visibleRange.last + 1);

  for (const edge of inputs.laneState.edges) {
    const fromIndex = commitIndex.get(edge.from);
    if (fromIndex === undefined) continue;
    const resolvedToIndex = commitIndex.get(edge.to) ?? inputs.entries.length;
    const startIndex = Math.min(fromIndex, resolvedToIndex);
    const endIndex = Math.max(fromIndex, resolvedToIndex);
    if (endIndex < minIndex || startIndex > maxIndex) continue;

    const fromY = getRowCenterY(fromIndex, rowByIndex, inputs.rowHeight, metrics.scrollTop);
    const toY = getRowCenterY(resolvedToIndex, rowByIndex, inputs.rowHeight, metrics.scrollTop);
    if (!verticalSpanIntersectsViewport(fromY, toY, metrics.cssHeight, inputs.rowHeight)) continue;

    edges.push({
      fromLane: edge.fromLane,
      toLane: edge.toLane,
      fromY,
      toY,
      kind: edge.kind,
    });
  }

  return edges;
}

/** Allows edge paths to enter one row above/below the viewport for clean clipping. */
function verticalSpanIntersectsViewport(
  fromY: number,
  toY: number,
  viewportHeight: number,
  rowHeight: number,
): boolean {
  const top = Math.min(fromY, toY) - rowHeight;
  const bottom = Math.max(fromY, toY) + rowHeight;
  return bottom >= 0 && top <= viewportHeight;
}

/** Prepares commit nodes for rows currently supplied by the virtualizer. */
function prepareVisibleRows(
  inputs: GraphDrawInputs,
  rowByIndex: ReadonlyMap<number, GraphCanvasVisibleRow>,
  metrics: CanvasMetrics,
): PreparedRow[] {
  const rows: PreparedRow[] = [];
  for (const [index, virtualRow] of rowByIndex) {
    const entry = inputs.entries[index];
    if (!entry) continue;
    const lane = inputs.laneState.laneByCommit.get(entry.sha);
    if (lane === undefined) continue;
    rows.push({
      entry,
      lane,
      y: virtualRow.start - metrics.scrollTop + virtualRow.size / 2,
    });
  }
  return rows;
}

/** Reads lane CSS custom properties on every redraw so theme changes are picked up. */
function readLaneColors(canvas: HTMLCanvasElement): readonly string[] {
  const computedStyle = canvas.ownerDocument.defaultView?.getComputedStyle(canvas);
  return DEFAULT_LANE_COLORS.map((fallback, index) => {
    const value = computedStyle?.getPropertyValue(`--color-git-lane-${index}`).trim();
    return value || fallback;
  });
}

/** Draws parent and merge connections before nodes so circles mask line joins. */
function drawEdges(
  ctx: CanvasRenderingContext2D,
  edges: readonly EdgeLayout[],
  laneColors: readonly string[],
  laneWidth: number,
  rowHeight: number,
): void {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = EDGE_WIDTH_PX;

  for (const edge of edges) {
    ctx.strokeStyle = getLaneColor(laneColors, edge.fromLane);
    ctx.beginPath();
    drawEdgePath(ctx, edge, laneWidth, rowHeight);
    ctx.stroke();
  }

  ctx.restore();
}

/** Draws one edge as a vertical line or a compact merge curve between lanes. */
function drawEdgePath(
  ctx: CanvasRenderingContext2D,
  edge: EdgeLayout,
  laneWidth: number,
  rowHeight: number,
): void {
  const fromX = getLaneX(edge.fromLane, laneWidth);
  const toX = getLaneX(edge.toLane, laneWidth);
  ctx.moveTo(fromX, edge.fromY);

  if (fromX === toX) {
    ctx.lineTo(toX, edge.toY);
    return;
  }

  const direction = edge.toY >= edge.fromY ? 1 : -1;
  const curveY = edge.fromY + direction * Math.min(rowHeight, Math.abs(edge.toY - edge.fromY) / 2);
  const leadY = edge.fromY + direction * Math.min(rowHeight / 2, Math.abs(curveY - edge.fromY));
  ctx.lineTo(fromX, leadY);
  ctx.quadraticCurveTo(fromX, curveY, toX, curveY);
  ctx.lineTo(toX, edge.toY);
}

/** Draws filled normal commits and same-radius hollow merge commits. */
function drawNodes(
  ctx: CanvasRenderingContext2D,
  rows: readonly PreparedRow[],
  laneColors: readonly string[],
  laneWidth: number,
): void {
  ctx.save();
  for (const row of rows) {
    const color = getLaneColor(laneColors, row.lane);
    const x = getLaneX(row.lane, laneWidth);
    ctx.beginPath();
    ctx.arc(x, row.y, NODE_RADIUS_PX, 0, Math.PI * 2);

    if (row.entry.parents.length > 1) {
      ctx.strokeStyle = color;
      ctx.lineWidth = MERGE_NODE_STROKE_WIDTH_PX;
      ctx.stroke();
      continue;
    }

    ctx.fillStyle = color;
    ctx.fill();
  }
  ctx.restore();
}

/** Computes the horizontal Canvas coordinate for a lane center. */
function getLaneX(lane: number, laneWidth: number): number {
  return lane * laneWidth + laneWidth / 2;
}

/** Reuses the eight measured theme tokens cyclically when the graph exceeds eight lanes. */
function getLaneColor(laneColors: readonly string[], lane: number): string {
  return laneColors[Math.abs(lane) % LANE_COLOR_COUNT] ?? DEFAULT_LANE_COLORS[0];
}
