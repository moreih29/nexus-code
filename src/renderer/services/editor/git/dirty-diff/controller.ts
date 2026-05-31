/**
 * Per-editor orchestration for the dirty-diff feature.
 *
 * Responsibilities:
 *   - load the HEAD baseline for the current file (via an injected source),
 *   - recompute line changes against the live buffer, debounced, on every edit,
 *   - paint / clear the gutter decorations,
 *   - open the inline peek when a gutter glyph is clicked.
 *
 * The controller is UI-framework-agnostic and depends only on a Monaco editor
 * instance plus a {@link DirtyDiffSource}. Baseline loading (git/IPC) is wired
 * by the install layer so this stays unit-testable.
 */

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
import type { DirtyChange } from "./types";

/** Coalesces bursts of keystrokes into a single recompute (matches VSCode). */
const RECOMPUTE_DEBOUNCE_MS = 300;

export interface DirtyDiffSource {
  /**
   * Returns the HEAD baseline text for the editor's current file, or `null`
   * when there is no baseline (untracked file, deleted at HEAD, not a repo).
   * A `null` result clears all dirty-diff decorations.
   */
  loadBaseline(signal: AbortSignal): Promise<string | null>;
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
    this.peek = new DirtyDiffPeek(editor, monaco);
  }

  /** Loads the baseline and wires listeners. Call once after construction. */
  start(): void {
    injectDirtyDiffStyles();

    this.disposables.push(
      this.editor.onDidChangeModelContent(() => this.scheduleRecompute()),
      this.editor.onMouseDown((e) => this.onMouseDown(e)),
    );

    void this.refreshBaseline();
  }

  /**
   * Reloads the baseline (e.g. after a commit/stage/checkout shifts HEAD) and
   * recomputes. Cancels any in-flight load first.
   */
  async refreshBaseline(): Promise<void> {
    if (this.disposed) return;
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;

    let baseline: string | null = null;
    try {
      baseline = await this.source.loadBaseline(controller.signal);
    } catch {
      // Baseline unavailable (aborted / IPC failure) — treat as no diff rather
      // than surfacing an error in the editor surface.
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

  // -------------------------------------------------------------------------

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

  /** Finds the change whose buffer footprint covers `line`. */
  private findChangeIndexForLine(line: number): number {
    return this.changes.findIndex((change) => {
      if (change.type === "delete") {
        // Deletions anchor to the line above the gap.
        return Math.max(1, change.modifiedStartLineNumber - 1) === line;
      }
      const end = change.modifiedEndLineNumber || change.modifiedStartLineNumber;
      return line >= change.modifiedStartLineNumber && line <= end;
    });
  }
}
