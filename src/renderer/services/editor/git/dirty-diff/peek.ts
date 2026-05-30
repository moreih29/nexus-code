/**
 * Inline "peek" of a single dirty-diff change — the small before/after panel
 * VSCode opens when you click a gutter marker.
 *
 * Architecture mirrors VSCode's `ZoneWidget`: a **view zone** reserves the
 * vertical space at the change line, while the interactive chrome lives in a
 * separate **overlay widget** pinned to the editor viewport. The overlay is the
 * key detail — overlay widgets do NOT scroll horizontally with the content, so
 * the toolbar (prev / next / close) stays reachable at the viewport's right
 * edge even when the file is scrolled sideways. (A naive "put everything in the
 * view-zone DOM node" approach instead stretches to the full scroll width,
 * pushing the close button off-screen and swallowing button clicks.)
 *
 * The overlay's vertical position and height are slaved to the view zone via
 * its `onDomNodeTop` / `onComputedHeight` callbacks; its width / left are
 * recomputed from the editor layout on every layout change.
 *
 * Snippets, not whole documents, back the embedded diff editor: the live buffer
 * model is already attached to the host editor and cannot be reused here, and
 * copying full documents would be wasteful. Each peek is a snapshot — it does
 * not live-update while open; closing and reclicking re-snapshots.
 */

import type * as Monaco from "monaco-editor";
import type { DirtyChange } from "./types";

/** Context lines shown around the change inside the peek. */
const CONTEXT_LINES = 2;
/** Header bar height in px (keep in sync with the injected CSS). */
const HEADER_HEIGHT = 26;
/** lucide SVG icon bodies (24x24 viewBox), rendered with currentColor stroke. */
const ICONS = {
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
} as const;

interface PeekState {
  changes: DirtyChange[];
  index: number;
  originalLines: string[];
  modifiedLines: string[];
  languageId: string;
}

export class DirtyDiffPeek {
  private viewZoneId: string | null = null;
  private overlay: Monaco.editor.IOverlayWidget | null = null;
  private diffEditor: Monaco.editor.IStandaloneDiffEditor | null = null;
  private originalModel: Monaco.editor.ITextModel | null = null;
  private modifiedModel: Monaco.editor.ITextModel | null = null;
  private container: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private label: HTMLElement | null = null;
  private readonly listeners: Monaco.IDisposable[] = [];
  private state: PeekState | null = null;
  private readonly overlayId = "nexus-dirty-diff-peek";

  constructor(
    private readonly editor: Monaco.editor.IStandaloneCodeEditor,
    private readonly monaco: typeof Monaco,
  ) {}

  /** Whether a peek is currently open. */
  get isOpen(): boolean {
    return this.viewZoneId !== null;
  }

  /**
   * Opens (or re-targets) the peek on `changes[index]`.
   *
   * @param originalText  Full HEAD baseline text (snippets are sliced from it).
   */
  open(changes: DirtyChange[], index: number, originalText: string): void {
    const model = this.editor.getModel();
    if (!model || index < 0 || index >= changes.length) return;

    this.state = {
      changes,
      index,
      originalLines: originalText.split(/\r\n|\r|\n/),
      modifiedLines: model.getLinesContent(),
      languageId: model.getLanguageId(),
    };

    if (this.isOpen) {
      this.update();
    } else {
      this.create();
    }
  }

  /** Navigates to the next change, wrapping at the end. */
  next(): void {
    if (!this.state) return;
    this.state.index = (this.state.index + 1) % this.state.changes.length;
    this.update();
  }

  /** Navigates to the previous change, wrapping at the start. */
  previous(): void {
    if (!this.state) return;
    const n = this.state.changes.length;
    this.state.index = (this.state.index - 1 + n) % n;
    this.update();
  }

  /** Tears down the peek and all owned resources. */
  close(): void {
    if (this.viewZoneId !== null) {
      const zoneId = this.viewZoneId;
      this.editor.changeViewZones((accessor) => accessor.removeZone(zoneId));
      this.viewZoneId = null;
    }
    if (this.overlay) {
      this.editor.removeOverlayWidget(this.overlay);
      this.overlay = null;
    }
    for (const d of this.listeners) d.dispose();
    this.listeners.length = 0;
    this.diffEditor?.dispose();
    this.diffEditor = null;
    this.originalModel?.dispose();
    this.originalModel = null;
    this.modifiedModel?.dispose();
    this.modifiedModel = null;
    this.container = null;
    this.body = null;
    this.label = null;
    this.state = null;
  }

  dispose(): void {
    this.close();
  }

  // -------------------------------------------------------------------------

  /** Builds the overlay widget, view zone, and embedded diff editor. */
  private create(): void {
    const state = this.state;
    if (!state) return;
    const change = state.changes[state.index];
    const { original, modified } = this.snippets(change);

    // Overlay container — pinned to the viewport, positioned manually.
    this.container = document.createElement("div");
    this.container.className = "nexus-dirty-diff-peek";
    this.container.style.position = "absolute";
    this.container.style.top = "-1000px"; // until the view zone reports its top
    this.container.appendChild(this.buildHeader());

    this.body = document.createElement("div");
    this.body.className = "nexus-dirty-diff-peek-body";
    this.container.appendChild(this.body);

    const heightInPx = this.zoneHeight(original, modified);

    // Empty spacer that reserves vertical room in the scroll content.
    const spacer = document.createElement("div");
    spacer.style.overflow = "hidden";

    this.editor.changeViewZones((accessor) => {
      this.viewZoneId = accessor.addZone({
        afterLineNumber: anchorFor(change),
        heightInPx,
        domNode: spacer,
        onDomNodeTop: (top) => {
          if (this.container) this.container.style.top = `${top}px`;
        },
        onComputedHeight: (h) => {
          if (this.body) this.body.style.height = `${h - HEADER_HEIGHT}px`;
          this.diffEditor?.layout();
        },
      });
    });

    // Overlay widget hosts the interactive chrome above the spacer.
    this.overlay = {
      getId: () => this.overlayId,
      getDomNode: () => this.container as HTMLElement,
      getPosition: () => null,
    };
    this.editor.addOverlayWidget(this.overlay);
    this.applyHorizontalLayout();

    this.diffEditor = this.monaco.editor.createDiffEditor(this.body, {
      renderSideBySide: false,
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      lineNumbers: "off",
      glyphMargin: false,
      folding: false,
      ignoreTrimWhitespace: false,
      scrollbar: { vertical: "auto", horizontal: "auto" },
    });
    this.applyModels(original, modified, state.languageId);
    this.updateLabel();
    this.revealChange(change);

    // Keep width/left in sync with the viewport on layout changes.
    this.listeners.push(
      this.editor.onDidLayoutChange(() => this.applyHorizontalLayout()),
      // Escape closes the peek when the host editor has focus.
      this.editor.onKeyDown((e) => {
        if (e.keyCode === this.monaco.KeyCode.Escape && this.isOpen) {
          e.stopPropagation();
          this.close();
        }
      }),
    );
  }

  /** Re-targets an already-open peek to the current change index. */
  private update(): void {
    const state = this.state;
    if (!state || this.viewZoneId === null) return;
    const change = state.changes[state.index];
    const { original, modified } = this.snippets(change);

    this.applyModels(original, modified, state.languageId);
    this.updateLabel();

    // Recreate the spacer zone at the navigated change's anchor; the overlay
    // follows via the new zone's onDomNodeTop / onComputedHeight callbacks.
    const heightInPx = this.zoneHeight(original, modified);
    const zoneId = this.viewZoneId;
    const spacer = document.createElement("div");
    spacer.style.overflow = "hidden";
    this.editor.changeViewZones((accessor) => {
      accessor.removeZone(zoneId);
      this.viewZoneId = accessor.addZone({
        afterLineNumber: anchorFor(change),
        heightInPx,
        domNode: spacer,
        onDomNodeTop: (top) => {
          if (this.container) this.container.style.top = `${top}px`;
        },
        onComputedHeight: (h) => {
          if (this.body) this.body.style.height = `${h - HEADER_HEIGHT}px`;
          this.diffEditor?.layout();
        },
      });
    });

    this.revealChange(change);
  }

  /**
   * Scrolls the host editor so the navigated change is in view. Without this,
   * navigating to a change outside the current viewport leaves the editor
   * unscrolled and the viewport-pinned overlay ends up positioned off-screen
   * (its top is slaved to the view zone, which is off-screen). Mirrors VSCode's
   * `revealLineInCenterIfOutsideViewport` on quick-diff navigation.
   */
  private revealChange(change: DirtyChange): void {
    const line = Math.max(1, change.modifiedStartLineNumber);
    this.editor.revealLineInCenterIfOutsideViewport(line, this.monaco.editor.ScrollType.Smooth);
  }

  /** Pins the overlay to the editor viewport width / left edge. */
  private applyHorizontalLayout(): void {
    if (!this.container) return;
    const info = this.editor.getLayoutInfo();
    const minimapWidth = info.minimap?.minimapWidth ?? 0;
    const minimapLeft = info.minimap?.minimapLeft ?? 0;
    const left = minimapWidth > 0 && minimapLeft === 0 ? minimapWidth : 0;
    const width = info.width - minimapWidth - info.verticalScrollbarWidth;
    this.container.style.left = `${left}px`;
    this.container.style.width = `${width}px`;
  }

  private applyModels(original: string[], modified: string[], languageId: string): void {
    // Recreate snippet models on every render — cheap, and avoids stale-content
    // bugs from reusing a model across changes.
    this.originalModel?.dispose();
    this.modifiedModel?.dispose();
    this.originalModel = this.monaco.editor.createModel(original.join("\n"), languageId);
    this.modifiedModel = this.monaco.editor.createModel(modified.join("\n"), languageId);
    this.diffEditor?.setModel({ original: this.originalModel, modified: this.modifiedModel });
  }

  private snippets(change: DirtyChange): { original: string[]; modified: string[] } {
    const state = this.state;
    if (!state) return { original: [], modified: [] };
    return {
      original: sliceSnippet(
        state.originalLines,
        change.originalStartLineNumber,
        change.originalEndLineNumber,
      ),
      modified: sliceSnippet(
        state.modifiedLines,
        change.modifiedStartLineNumber,
        change.modifiedEndLineNumber,
      ),
    };
  }

  private zoneHeight(original: string[], modified: string[]): number {
    const lineHeight = this.editor.getOption(this.monaco.editor.EditorOption.lineHeight);
    const bodyLines = Math.max(original.length, modified.length, 1);
    const maxBodyLines = Math.max(
      3,
      Math.floor(this.editor.getLayoutInfo().height / lineHeight / 3),
    );
    const visibleBodyLines = Math.min(bodyLines + 1, maxBodyLines);
    return HEADER_HEIGHT + visibleBodyLines * lineHeight;
  }

  private buildHeader(): HTMLElement {
    const header = document.createElement("div");
    header.className = "nexus-dirty-diff-peek-header";

    this.label = document.createElement("span");
    this.label.className = "nexus-dirty-diff-peek-label";
    header.appendChild(this.label);

    const actions = document.createElement("div");
    actions.className = "nexus-dirty-diff-peek-actions";

    const mkButton = (icon: string, title: string, onClick: () => void): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "nexus-dirty-diff-peek-btn";
      btn.title = title;
      btn.setAttribute("aria-label", title);
      btn.innerHTML = lucideSvg(icon);
      // Use mousedown + preventDefault so the host editor never steals focus
      // (which would otherwise swallow the following click).
      btn.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onClick();
      });
      return btn;
    };

    actions.appendChild(mkButton(ICONS.chevronUp, "Previous change", () => this.previous()));
    actions.appendChild(mkButton(ICONS.chevronDown, "Next change", () => this.next()));
    actions.appendChild(mkButton(ICONS.x, "Close (Esc)", () => this.close()));
    header.appendChild(actions);

    return header;
  }

  private updateLabel(): void {
    if (!this.state || !this.label) return;
    this.label.textContent = `Change ${this.state.index + 1} of ${this.state.changes.length}`;
  }
}

/** Wraps a lucide icon path in an SVG element string (stroke = currentColor). */
function lucideSvg(pathMarkup: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"` +
    ` fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"` +
    ` stroke-linejoin="round">${pathMarkup}</svg>`
  );
}

/** View-zone anchor: place the peek just below the change in the buffer. */
function anchorFor(change: DirtyChange): number {
  if (change.type === "delete") return Math.max(0, change.modifiedStartLineNumber - 1);
  return change.modifiedEndLineNumber || change.modifiedStartLineNumber;
}

/**
 * Extracts the lines covering [start, end] (1-based inclusive) plus a few lines
 * of surrounding context. Empty ranges (end === 0) yield no lines for that side.
 */
function sliceSnippet(lines: string[], start: number, end: number): string[] {
  if (end === 0) return [];
  const from = Math.max(0, start - 1 - CONTEXT_LINES);
  const to = Math.min(lines.length, end + CONTEXT_LINES);
  return lines.slice(from, to);
}
