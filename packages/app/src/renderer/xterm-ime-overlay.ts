export interface XtermImeCursorAnchor {
  x: number;
  y: number;
  height: number;
}

export interface KeyboardEventLike {
  key: string;
  isComposing: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export const XTERM_IME_PATCH_ROOT_CLASS = "nx-xterm-ime-patch";
export const XTERM_IME_OVERLAY_CLASS = "nx-xterm-ime-overlay";
export const XTERM_IME_STYLE_ELEMENT_ID = "nx-xterm-ime-style";

export const XTERM_IME_PATCH_CSS = `
.${XTERM_IME_PATCH_ROOT_CLASS} .composition-view {
  display: none !important;
}

.${XTERM_IME_PATCH_ROOT_CLASS} .${XTERM_IME_OVERLAY_CLASS} {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
  white-space: pre;
}
`;

export interface StyleNodeLike {
  id?: string;
  textContent?: string | null;
}

export interface StyleDocumentLike {
  getElementById?(id: string): unknown;
  createElement?(tagName: string): StyleNodeLike;
  head?: { appendChild?(node: unknown): void } | null;
}

export function toXtermImeOverlayTransform(anchor: XtermImeCursorAnchor): string {
  return `translate(${Math.round(anchor.x)}px, ${Math.round(anchor.y)}px)`;
}

export function shouldSwallowEnterDuringComposition(
  event: Pick<KeyboardEventLike, "key" | "isComposing">,
): boolean {
  return event.key === "Enter" && event.isComposing;
}

export function handleEnterDuringComposition(event: KeyboardEventLike): boolean {
  if (!shouldSwallowEnterDuringComposition(event)) {
    return false;
  }

  event.preventDefault();
  event.stopPropagation();
  return true;
}

export function ensureXtermImePatchStyle(documentLike: StyleDocumentLike | null | undefined): void {
  if (!documentLike) {
    return;
  }

  if (documentLike.getElementById?.(XTERM_IME_STYLE_ELEMENT_ID)) {
    return;
  }

  const styleElement = documentLike.createElement?.("style");
  if (!styleElement) {
    return;
  }

  styleElement.id = XTERM_IME_STYLE_ELEMENT_ID;
  styleElement.textContent = XTERM_IME_PATCH_CSS;
  documentLike.head?.appendChild?.(styleElement);
}

export class XtermCompositionBuffer {
  private composing = false;
  private bufferedText = "";
  private suppressedTerminalData: string | null = null;

  public start(): void {
    this.composing = true;
    this.bufferedText = "";
  }

  public update(data: string): void {
    if (!this.composing) {
      return;
    }
    this.bufferedText = data;
  }

  public end(data: string | null | undefined): string | null {
    if (!this.composing) {
      return null;
    }

    const committedText = data && data.length > 0 ? data : this.bufferedText;
    this.composing = false;
    this.bufferedText = "";

    if (committedText.length === 0) {
      this.suppressedTerminalData = null;
      return null;
    }

    this.suppressedTerminalData = committedText;
    return committedText;
  }

  public isComposing(): boolean {
    return this.composing;
  }

  public getBufferedText(): string {
    return this.bufferedText;
  }

  public shouldForwardTerminalData(data: string): boolean {
    if (this.composing) {
      return false;
    }

    if (this.suppressedTerminalData !== null && this.suppressedTerminalData === data) {
      this.suppressedTerminalData = null;
      return false;
    }

    this.suppressedTerminalData = null;
    return true;
  }

  public reset(): void {
    this.composing = false;
    this.bufferedText = "";
    this.suppressedTerminalData = null;
  }
}

export interface OverlayNodeLike {
  className?: string;
  textContent?: string | null;
  style?: {
    position?: string;
    left?: string;
    top?: string;
    transform?: string;
    minHeight?: string;
    pointerEvents?: string;
    whiteSpace?: string;
    visibility?: string;
  };
}

export interface OverlayHostLike {
  style?: {
    position?: string;
  };
  classList?: {
    add?(token: string): void;
    remove?(token: string): void;
  };
  ownerDocument?: StyleDocumentLike | null;
  appendChild?(node: unknown): void;
  removeChild?(node: unknown): void;
}

const OFFSCREEN_TRANSFORM = "translate(-10000px, -10000px)";

export class XtermImeOverlay {
  private readonly host: OverlayHostLike;
  private readonly hostPositionBefore: string | undefined;
  private readonly hostPositionPatched: boolean;
  private readonly overlayNode: OverlayNodeLike | null;

  public constructor(host: OverlayHostLike) {
    this.host = host;
    this.host.classList?.add?.(XTERM_IME_PATCH_ROOT_CLASS);

    this.hostPositionBefore = this.host.style?.position;
    this.hostPositionPatched =
      Boolean(this.host.style) &&
      (!this.host.style?.position || this.host.style.position === "static");
    if (this.hostPositionPatched && this.host.style) {
      this.host.style.position = "relative";
    }

    const overlayNode = host.ownerDocument?.createElement?.("div") as
      | OverlayNodeLike
      | undefined;
    if (!overlayNode) {
      this.overlayNode = null;
      return;
    }

    overlayNode.className = XTERM_IME_OVERLAY_CLASS;
    overlayNode.textContent = "";
    overlayNode.style = overlayNode.style ?? {};
    overlayNode.style.position = "absolute";
    overlayNode.style.left = "0";
    overlayNode.style.top = "0";
    overlayNode.style.pointerEvents = "none";
    overlayNode.style.whiteSpace = "pre";
    overlayNode.style.visibility = "hidden";
    overlayNode.style.transform = OFFSCREEN_TRANSFORM;

    this.host.appendChild?.(overlayNode);
    this.overlayNode = overlayNode;
  }

  public render(text: string, anchor: XtermImeCursorAnchor | null | undefined): void {
    if (!this.overlayNode || !this.overlayNode.style) {
      return;
    }

    if (!anchor || text.length === 0) {
      this.hide();
      return;
    }

    this.overlayNode.textContent = text;
    this.overlayNode.style.minHeight = `${Math.max(0, Math.round(anchor.height))}px`;
    this.overlayNode.style.transform = toXtermImeOverlayTransform(anchor);
    this.overlayNode.style.visibility = "visible";
  }

  public hide(): void {
    if (!this.overlayNode || !this.overlayNode.style) {
      return;
    }

    this.overlayNode.textContent = "";
    this.overlayNode.style.visibility = "hidden";
    this.overlayNode.style.transform = OFFSCREEN_TRANSFORM;
  }

  public dispose(): void {
    this.hide();

    if (this.overlayNode) {
      this.host.removeChild?.(this.overlayNode);
    }

    this.host.classList?.remove?.(XTERM_IME_PATCH_ROOT_CLASS);

    if (this.hostPositionPatched && this.host.style) {
      this.host.style.position = this.hostPositionBefore;
    }
  }
}
