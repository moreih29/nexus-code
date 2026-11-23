import i18next from "i18next";
import type * as Monaco from "monaco-editor";
import type { DirtyChange } from "./types";

const CONTEXT_LINES = 2;
const HEADER_HEIGHT = 26;
const ICONS = {
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
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
    private readonly onRevert?: (change: DirtyChange) => void,
    private readonly onStage?: (change: DirtyChange) => void,
  ) {}

  get isOpen(): boolean {
    return this.viewZoneId !== null;
  }

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

  next(): void {
    if (!this.state) return;
    this.state.index = (this.state.index + 1) % this.state.changes.length;
    this.update();
  }

  previous(): void {
    if (!this.state) return;
    const n = this.state.changes.length;
    this.state.index = (this.state.index - 1 + n) % n;
    this.update();
  }

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

  private create(): void {
    const state = this.state;
    if (!state) return;
    const change = state.changes[state.index];
    const { original, modified } = this.snippets(change);

    this.container = document.createElement("div");
    this.container.className = "nexus-dirty-diff-peek";
    this.container.style.position = "absolute";
    this.container.style.top = "-1000px";
    this.container.appendChild(this.buildHeader());

    this.body = document.createElement("div");
    this.body.className = "nexus-dirty-diff-peek-body";
    this.container.appendChild(this.body);

    const heightInPx = this.zoneHeight(original, modified);

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

    this.listeners.push(
      this.editor.onDidLayoutChange(() => this.applyHorizontalLayout()),
      this.editor.onKeyDown((e) => {
        if (e.keyCode === this.monaco.KeyCode.Escape && this.isOpen) {
          e.stopPropagation();
          this.close();
        }
      }),
    );
  }

  private update(): void {
    const state = this.state;
    if (!state || this.viewZoneId === null) return;
    const change = state.changes[state.index];
    const { original, modified } = this.snippets(change);

    this.applyModels(original, modified, state.languageId);
    this.updateLabel();

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

  private revealChange(change: DirtyChange): void {
    const line = Math.max(1, change.modifiedStartLineNumber);
    this.editor.revealLineInCenterIfOutsideViewport(line, this.monaco.editor.ScrollType.Smooth);
  }

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
    const previous = [this.originalModel, this.modifiedModel];
    this.originalModel = this.monaco.editor.createModel(original.join("\n"), languageId);
    this.modifiedModel = this.monaco.editor.createModel(modified.join("\n"), languageId);
    this.diffEditor?.setModel({ original: this.originalModel, modified: this.modifiedModel });
    for (const model of previous) model?.dispose();
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
      btn.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onClick();
      });
      return btn;
    };

    if (this.onStage) {
      actions.appendChild(
        mkButton(ICONS.plus, i18next.t("editor.dirty_diff_stage"), () => {
          const change = this.state?.changes[this.state.index];
          if (change) this.onStage?.(change);
        }),
      );
    }
    if (this.onRevert && !this.editor.getOption(this.monaco.editor.EditorOption.readOnly)) {
      actions.appendChild(
        mkButton(ICONS.undo, i18next.t("editor.dirty_diff_revert"), () => {
          const change = this.state?.changes[this.state.index];
          if (change) this.onRevert?.(change);
        }),
      );
    }
    actions.appendChild(
      mkButton(ICONS.chevronUp, i18next.t("editor.dirty_diff_previous"), () => this.previous()),
    );
    actions.appendChild(
      mkButton(ICONS.chevronDown, i18next.t("editor.dirty_diff_next"), () => this.next()),
    );
    actions.appendChild(
      mkButton(ICONS.x, i18next.t("editor.dirty_diff_close"), () => this.close()),
    );
    header.appendChild(actions);

    return header;
  }

  private updateLabel(): void {
    if (!this.state || !this.label) return;
    this.label.textContent = i18next.t("editor.dirty_diff_position", {
      index: this.state.index + 1,
      count: this.state.changes.length,
    });
  }
}

function lucideSvg(pathMarkup: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"` +
    ` fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"` +
    ` stroke-linejoin="round">${pathMarkup}</svg>`
  );
}

function anchorFor(change: DirtyChange): number {
  if (change.type === "delete") return Math.max(0, change.modifiedStartLineNumber - 1);
  return change.modifiedEndLineNumber || change.modifiedStartLineNumber;
}

export function sliceSnippet(lines: readonly string[], start: number, end: number): string[] {
  const from = Math.max(0, start - 1 - CONTEXT_LINES);
  const to = Math.min(lines.length, (end === 0 ? start - 1 : end) + CONTEXT_LINES);
  return lines.slice(from, to);
}
