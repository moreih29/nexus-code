import { randomUUID } from "node:crypto";
import { type AgentProfile, defaultProfileId } from "../../../shared/agent-profiles/profiles";
import { createLogger } from "../../../shared/log/main";
import type { DocNode } from "../../../shared/notes/markdown";
import {
  failedSummary,
  type RecordingSummary,
  type RecordingSummarySettings,
  type RunningSummary,
  type SummaryMode,
  summaryOrigin,
} from "../../../shared/notes/summary";
import { recordingMs } from "../../../shared/notes/transcript";
import type { NoteLocation } from "../../../shared/notes/types";
import { NoteError, type NotesStore } from "./store";
import { summaryBlocks } from "./summary-blocks";
import type { RunClaudeSummary } from "./summary-claude";
import { type SummaryLanguage, summaryInput, summaryLanguage } from "./summary-text";

const log = createLogger("notes-summary");

export interface SummaryTarget {
  location: NoteLocation;
  noteId: string;
  recordingId: string;
}

type Change = { next: RecordingSummary; updateDocument?: () => Promise<void> };

export interface NotesSummaryOptions {
  store: NotesStore;
  settings: () => RecordingSummarySettings;
  language: () => SummaryLanguage;
  profile: (id: string) => AgentProfile | null;
  runClaude: RunClaudeSummary;
  onState: (
    locationKey: string,
    noteId: string,
    recordingId: string,
    state: RecordingSummary,
  ) => void;
  append: (target: SummaryTarget, blocks: DocNode[]) => Promise<void>;
  onRemoved: (target: SummaryTarget, origin: string) => void;
}

/** Owns the queue across all note locations and renderer windows in this main process. */
export class NotesSummary {
  private readonly ready: Promise<void>;
  private tail = Promise.resolve();
  private readonly runs = new Map<string, AbortController>();
  private closed = false;

  constructor(private readonly opts: NotesSummaryOptions) {
    this.ready = opts.store.recoverSummaries(opts.onState).catch((error) => {
      log.warn(`Could not recover recording summaries: ${String(error)}`);
    });
  }

  async states(location: NoteLocation, noteId: string) {
    await this.ready;
    return this.opts.store.summaries(location, noteId);
  }

  async summarize(target: SummaryTarget, mode: SummaryMode): Promise<RecordingSummary | null> {
    await this.ready;
    const settings = this.opts.settings();
    if (this.closed || (mode === "auto" && !settings.enabled)) return null;
    const profileId = settings.profileId ?? defaultProfileId("claude");
    const run: RunningSummary = {
      state: "running",
      runId: randomUUID(),
      agent: "claude",
      profileId,
      model: settings.model,
      startedAt: Date.now(),
      seen: false,
    };
    const controller = new AbortController();
    this.runs.set(run.runId, controller);
    let next: RecordingSummary | undefined;
    let removed = 0;
    const origin = summaryOrigin(target.recordingId);
    try {
      next = await this.edit(target, async (current, inHistory) => {
        if (
          this.closed ||
          current?.state === "running" ||
          (mode === "auto" && (current || inHistory)) ||
          (mode === "retry" && current?.state !== "failed")
        )
          return;
        const recording = await this.recording(target);
        if (
          recordingMs(recording) < 30_000 ||
          recording.lines.filter((line) => line.text.trim()).length < 3
        ) {
          return { next: { ...run, state: "skipped", endedAt: Date.now() } };
        }
        return {
          next: run,
          updateDocument:
            mode === "rerun"
              ? async () => {
                  removed = await this.opts.store.removeBlocksByOrigin(
                    target.location,
                    target.noteId,
                    origin,
                  );
                }
              : undefined,
        };
      });
    } finally {
      if (next?.state !== "running") this.runs.delete(run.runId);
    }
    if (removed) this.opts.onRemoved(target, origin);
    if (next?.state === "running") {
      this.tail = this.tail
        .then(() => this.execute(target, run, profileId, controller.signal))
        .catch((error) => log.warn(`Could not finish recording summary: ${String(error)}`))
        .finally(() => {
          this.runs.delete(run.runId);
        });
    }
    return next ?? null;
  }

  async cancel(target: SummaryTarget): Promise<boolean> {
    return Boolean(
      await this.edit(target, async (current) => {
        if (current?.state !== "running") return;
        this.runs.get(current.runId)?.abort();
        return { next: failedSummary(current, { kind: "interrupted" }) };
      }),
    );
  }

  async dismiss(target: SummaryTarget): Promise<boolean> {
    return Boolean(
      await this.edit(target, async (current) =>
        current && current.state !== "running" && !current.seen
          ? { next: { ...current, seen: true } }
          : undefined,
      ),
    );
  }

  async undo(target: SummaryTarget): Promise<number> {
    let removed = 0;
    const origin = summaryOrigin(target.recordingId);
    await this.edit(target, async (current) => {
      if (current?.state !== "done" || current.seen) return;
      const { todos: _todos, ...previous } = current;
      return {
        next: { ...previous, state: "undone", endedAt: Date.now() },
        updateDocument: async () => {
          removed = await this.opts.store.removeBlocksByOrigin(
            target.location,
            target.noteId,
            origin,
          );
        },
      };
    });
    if (removed) this.opts.onRemoved(target, origin);
    return removed;
  }

  dispose(): void {
    this.closed = true;
    for (const run of this.runs.values()) run.abort();
  }

  async waitForIdle(): Promise<void> {
    await this.ready;
    await this.tail;
  }

  private async edit(
    target: SummaryTarget,
    fn: (current: RecordingSummary | undefined, inHistory: boolean) => Promise<Change | undefined>,
  ) {
    await this.ready;
    const { location, noteId, recordingId } = target;
    const state = await this.opts.store.editSummary(location, noteId, recordingId, fn);
    if (state) this.opts.onState(location.key, noteId, recordingId, state);
    return state;
  }

  private async recording({ location, noteId, recordingId }: SummaryTarget) {
    const transcript = await this.opts.store.readTranscript(location, noteId);
    const recording = transcript.recordings.find(({ id }) => id === recordingId);
    if (!recording) throw new NoteError("not-found", `no recording ${recordingId}`);
    return recording;
  }

  private async execute(
    target: SummaryTarget,
    run: RunningSummary,
    profileId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const finish = (next: RecordingSummary, updateDocument?: () => Promise<void>) =>
      this.edit(target, async (current) =>
        current?.state === "running" && current.runId === run.runId
          ? { next, updateDocument }
          : undefined,
      );
    const done = (todos: number): RecordingSummary => ({
      ...run,
      state: "done",
      endedAt: Date.now(),
      todos,
    });
    try {
      signal.throwIfAborted();
      const { location, noteId, recordingId } = target;
      const note = await this.opts.store.read(location, noteId);
      const recording = await this.recording(target);
      const origin = summaryOrigin(recordingId);
      const applied = note.doc.content?.filter((block) => block.attrs?.nexusOrigin === origin);
      if (applied?.length) {
        // A prior run may have written the document just before the process quit.
        const todos = applied.find((block) => block.type === "taskList")?.content?.length ?? 0;
        await finish(done(Math.min(todos, 15)));
        return;
      }
      const language = this.opts.language();
      const stdin = summaryInput(note.title, recording, language);
      if (!stdin) {
        await finish(failedSummary(run, { kind: "too-long" }));
        return;
      }
      const profile = this.opts.profile(profileId);
      if (profile?.agent !== "claude") {
        await finish(failedSummary(run, { kind: "missing" }));
        return;
      }
      const response = await this.opts.runClaude({
        runId: run.runId,
        profile,
        model: run.model,
        language: summaryLanguage(recording, language),
        stdin,
        signal,
      });
      signal.throwIfAborted();
      if ("error" in response) {
        await finish(failedSummary(run, response.error));
      } else {
        const blocks = summaryBlocks(recording, response.output, language);
        await finish(done(response.output.todos.length), async () => {
          await this.recording(target);
          await this.opts.append(target, blocks);
        });
      }
    } catch {
      await finish(
        failedSummary(
          run,
          signal.aborted
            ? { kind: "interrupted" }
            : { kind: "failed", message: "Could not complete the recording summary" },
        ),
      );
    }
  }
}
