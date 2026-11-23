import type * as Monaco from "monaco-editor";
import type { TimerScheduler } from "../../../../../shared/util/timer-scheduler";
import { defaultTimerScheduler } from "../../../../../shared/util/timer-scheduler";
import { computeDirtyChanges } from "./compute";
import {
  buildDirtyDiffDecorations,
  injectDirtyDiffStyles,
  isDirtyDiffGlyphTarget,
} from "./decorations";
import { DirtyDiffPeek } from "./peek";
import { revertChangeEdit } from "./revert";
import type { DirtyChange } from "./types";

const RECOMPUTE_DEBOUNCE_MS = 300;

export interface DirtyDiffSource {
  loadBaseline(signal: AbortSignal): Promise<string | null>;
  stageChange?(change: DirtyChange, working: string, eol: string): Promise<void>;
}

export class DirtyDiffController {
  private readonly decorations: Monaco.editor.IEditorDecorationsCollection;
  private readonly peek: DirtyDiffPeek;
  private readonly scheduler: TimerScheduler;
  private readonly disposables: Monaco.IDisposable[] = [];

  private baseline: string | null = null;
  private changes: DirtyChange[] = [];
  private debounceTimer: unknown = null;
  private abortController: AbortController | null = null;
  private disposed = false;

  constructor(
    private readonly editor: Monaco.editor.IStandaloneCodeEditor,
    private readonly monaco: typeof Monaco,
    private readonly source: DirtyDiffSource,
    scheduler: TimerScheduler = defaultTimerScheduler,
  ) {
    this.scheduler = scheduler;
    this.decorations = editor.createDecorationsCollection([]);
    this.peek = new DirtyDiffPeek(
      editor,
      monaco,
      (change) => this.revertChange(change),
      source.stageChange ? (change) => void this.stageChange(change) : undefined,
    );
  }

  get hasChanges(): boolean {
    return this.changes.length > 0;
  }

  start(): void {
    injectDirtyDiffStyles();

    this.disposables.push(
      this.editor.onDidChangeModelContent(() => this.scheduleRecompute()),
      this.editor.onMouseDown((e) => this.onMouseDown(e)),
    );

    void this.refreshBaseline();
  }

  async refreshBaseline(): Promise<void> {
    if (this.disposed) return;
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;

    let baseline: string | null = null;
    try {
      baseline = await this.source.loadBaseline(controller.signal);
    } catch {
      baseline = null;
    }
    if (this.disposed || controller.signal.aborted) return;

    this.baseline = baseline;
    this.recompute();
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer !== null) {
      this.scheduler.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.abortController?.abort();
    this.abortController = null;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.peek.dispose();
    this.decorations.clear();
  }

  private scheduleRecompute(): void {
    if (this.debounceTimer !== null) this.scheduler.clearTimeout(this.debounceTimer);
    this.debounceTimer = this.scheduler.setTimeout(() => {
      this.debounceTimer = null;
      this.recompute();
    }, RECOMPUTE_DEBOUNCE_MS);
  }

  private recompute(): void {
    if (this.disposed) return;
    const model = this.editor.getModel();
    if (!model || this.baseline === null) {
      this.changes = [];
      this.decorations.clear();
      return;
    }

    this.changes = computeDirtyChanges(this.baseline, model.getValue());
    this.decorations.set(buildDirtyDiffDecorations(this.monaco, model, this.changes));
  }

  private revertChange(change: DirtyChange): void {
    const model = this.editor.getModel();
    if (!model || this.baseline === null) return;

    this.flushRecompute();
    const index = this.changes.findIndex((c) => sameChange(c, change));
    if (index === -1) {
      this.peek.close();
      return;
    }

    const { range, text } = revertChangeEdit(change, this.baseline.split(/\r\n|\r|\n/), model);
    this.editor.pushUndoStop();
    this.editor.executeEdits("dirty-diff.revert", [
      {
        range: new this.monaco.Range(
          range.startLineNumber,
          range.startColumn,
          range.endLineNumber,
          range.endColumn,
        ),
        text,
        forceMoveMarkers: true,
      },
    ]);
    this.editor.pushUndoStop();

    this.flushRecompute();
    if (this.changes.length === 0) {
      this.peek.close();
    } else {
      this.peek.open(this.changes, Math.min(index, this.changes.length - 1), this.baseline);
    }
  }

  private async stageChange(change: DirtyChange): Promise<void> {
    const model = this.editor.getModel();
    if (!model || !this.source.stageChange) return;

    this.flushRecompute();
    const index = this.changes.findIndex((c) => sameChange(c, change));
    if (index === -1) {
      this.peek.close();
      return;
    }

    await this.source.stageChange(change, model.getValue(), model.getEOL());
    await this.refreshBaseline();
    if (this.disposed || !this.peek.isOpen) return;
    if (this.changes.length === 0 || this.baseline === null) {
      this.peek.close();
    } else {
      this.peek.open(this.changes, Math.min(index, this.changes.length - 1), this.baseline);
    }
  }

  private flushRecompute(): void {
    if (this.debounceTimer !== null) {
      this.scheduler.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.recompute();
  }

  private onMouseDown(e: Monaco.editor.IEditorMouseEvent): void {
    if (this.changes.length === 0) return;
    if (e.target.type !== this.monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return;

    const element = e.target.element as HTMLElement | null;
    if (!isDirtyDiffGlyphTarget(element?.className)) return;

    const line = e.target.position?.lineNumber;
    if (line === undefined) return;

    const index = this.findChangeIndexForLine(line);
    if (index === -1 || this.baseline === null) return;

    this.peek.open(this.changes, index, this.baseline);
  }

  private findChangeIndexForLine(line: number): number {
    return this.changes.findIndex((change) => {
      if (change.type === "delete") {
        return Math.max(1, change.modifiedStartLineNumber - 1) === line;
      }
      const end = change.modifiedEndLineNumber || change.modifiedStartLineNumber;
      return line >= change.modifiedStartLineNumber && line <= end;
    });
  }
}

function sameChange(a: DirtyChange, b: DirtyChange): boolean {
  return (
    a.originalStartLineNumber === b.originalStartLineNumber &&
    a.originalEndLineNumber === b.originalEndLineNumber &&
    a.modifiedStartLineNumber === b.modifiedStartLineNumber &&
    a.modifiedEndLineNumber === b.modifiedEndLineNumber
  );
}
