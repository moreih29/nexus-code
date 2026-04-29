import type { ExternalEditorDropEdge } from "../../services/editor-types";

export interface EditorDropEdgeResolverRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ResolveEditorDropEdgeInput {
  clientX: number;
  clientY: number;
  rect: EditorDropEdgeResolverRect;
  altKey?: boolean;
  allowCornerEdges?: boolean;
}

const EDGE_ZONE_RATIO = 0.33;
const CENTER_ZONE_MAX_RATIO = 0.67;

export function resolveEditorDropEdge({
  clientX,
  clientY,
  rect,
  altKey = false,
  allowCornerEdges = true,
}: ResolveEditorDropEdgeInput): ExternalEditorDropEdge | null {
  if (!isUsableRect(rect)) {
    return null;
  }

  const xRatio = clampRatio((clientX - rect.left) / rect.width);
  const yRatio = clampRatio((clientY - rect.top) / rect.height);
  const horizontalEdge = horizontalDropEdgeForRatio(xRatio);
  const verticalEdge = verticalDropEdgeForRatio(yRatio);

  if (altKey && allowCornerEdges && horizontalEdge && verticalEdge) {
    return `${verticalEdge}-${horizontalEdge}`;
  }

  if (!horizontalEdge && !verticalEdge) {
    return "center";
  }

  return verticalEdge ?? horizontalEdge ?? "center";
}

function horizontalDropEdgeForRatio(ratio: number): "left" | "right" | null {
  if (ratio < EDGE_ZONE_RATIO) {
    return "left";
  }
  if (ratio > CENTER_ZONE_MAX_RATIO) {
    return "right";
  }
  return null;
}

function verticalDropEdgeForRatio(ratio: number): "top" | "bottom" | null {
  if (ratio < EDGE_ZONE_RATIO) {
    return "top";
  }
  if (ratio > CENTER_ZONE_MAX_RATIO) {
    return "bottom";
  }
  return null;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(Math.max(value, 0), 1);
}

function isUsableRect(rect: EditorDropEdgeResolverRect): boolean {
  return Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0;
}
