import fs from "node:fs";
import { z } from "zod";
import { createLogger } from "../../../shared/log/main";
import {
  type AppState,
  AppStateSchema,
  type WindowBounds,
  WindowBoundsSchema,
} from "../../../shared/types/app-state";
import { migrateAppState } from "./app-state-migrations";
import { errnoText } from "./errno-text";
import { CANCELLED, PREPARING, RENAMING, renameWhenUnlocked, writeStateFile } from "./state-file";
import { StateWorkerError, StateWriter } from "./state-writer";

const log = createLogger("storage");
const WRITE_DELAY_MS = 25;
const RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 8_000;
const RENAME_WAIT_MS = 1_000;
const MAX_WORKER_FAILURES = 3;

export { type AppState, AppStateSchema, type WindowBounds, WindowBoundsSchema };

interface MergeLayouts {
  readonly workspaceIds?: readonly string[];
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function pickWorkspaceLayouts<T>(
  layouts: Record<string, T>,
  workspaceIds: readonly string[],
): Record<string, T> {
  return Object.fromEntries(
    workspaceIds.flatMap((id) => (Object.hasOwn(layouts, id) ? [[id, layouts[id]]] : [])),
  );
}

export class StateService {
  private readonly writer: StateWriter;
  private state: AppState;
  private revision = 0;
  private writtenRevision = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private writing?: Int32Array;
  private retryDelay = RETRY_DELAY_MS;
  private workerFailures = 0;
  private useSyncWriter = false;
  private readonly pendingPath: string;
  private pendingRevision?: number;

  constructor(
    private readonly filePath: string,
    workerPath: string,
  ) {
    this.pendingPath = `${filePath}.pending`;
    this.state = this.load();
    this.writer = new StateWriter(filePath, workerPath);
    if (this.pendingRevision !== undefined) {
      this.revision++;
      this.scheduleWrite(RETRY_DELAY_MS);
    }
  }

  private load(): AppState {
    const empty = AppStateSchema.parse({});
    const kept = this.restorePending();
    let raw: unknown;
    try {
      raw = migrateAppState(kept ?? JSON.parse(fs.readFileSync(this.filePath, "utf8")));
    } catch (error) {
      if (!kept && errorCode(error) !== "ENOENT") this.backUpInvalidFile();
      return empty;
    }
    const parsed = AppStateSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    if (!kept) this.backUpInvalidFile();
    return salvageAppState(raw, empty);
  }

  private restorePending(): Record<string, unknown> | undefined {
    let text: string;
    try {
      if (this.savedSincePending()) return this.discardPending("the saved state is newer");
      text = fs.readFileSync(this.pendingPath, "utf8");
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT") {
        log.warn(`Ignored the app state kept at the last quit: it could not be read (${code})`);
      }
      return undefined;
    }
    let kept: unknown;
    try {
      kept = JSON.parse(text);
    } catch {
      return this.discardPending("it is not valid JSON");
    }
    if (!isPlainRecord(kept)) return this.discardPending("it is not a JSON object");
    try {
      renameWhenUnlocked(this.pendingPath, this.filePath);
    } catch (error) {
      log.warn(
        `Using the app state kept at the last quit until the next save: it could not replace the saved state (${errorCode(error)})`,
      );
      this.pendingRevision = 0;
      return kept;
    }
    log.info("Restored the app state kept at the last quit");
    return undefined;
  }

  private savedSincePending(): boolean {
    const keptAt = fs.statSync(this.pendingPath).mtimeMs;
    try {
      return fs.statSync(this.filePath).mtimeMs > keptAt;
    } catch {
      return false;
    }
  }

  private discardPending(reason: string): undefined {
    log.warn(`Discarded the app state kept at the last quit: ${reason}`);
    try {
      fs.unlinkSync(this.pendingPath);
    } catch (error) {
      log.warn(`Could not remove the discarded app state copy (${errorCode(error)})`);
    }
    return undefined;
  }

  private backUpInvalidFile(): void {
    try {
      fs.copyFileSync(this.filePath, `${this.filePath}.invalid`);
    } catch {}
  }

  getState(): Readonly<AppState> {
    return this.state;
  }

  setState(partial: Partial<AppState>, mergeLayouts?: MergeLayouts): void {
    this.state = this.update(partial, mergeLayouts);
    this.revision++;
    this.scheduleWrite(WRITE_DELAY_MS);
  }

  mergeState(partial: Partial<AppState>): void {
    this.setState(partial);
  }

  commitState(partial: Partial<AppState>): void {
    const next = this.update(partial);
    this.writeNow(next);
    this.state = next;
    this.markWritten(++this.revision);
  }

  private update(partial: Partial<AppState>, mergeLayouts?: MergeLayouts): AppState {
    const next = { ...this.state, ...partial };
    const workspaceIds = mergeLayouts?.workspaceIds;
    const mergesLayouts = mergeLayouts && Object.hasOwn(partial, "layoutByWorkspace");
    if (mergesLayouts && workspaceIds && isPlainRecord(next.layoutByWorkspace)) {
      next.layoutByWorkspace = pickWorkspaceLayouts(next.layoutByWorkspace, workspaceIds);
    }
    const { shape } = AppStateSchema;
    for (const key of Object.keys(partial) as (keyof AppState)[]) {
      if (Object.hasOwn(shape, key) && !shape[key].safeParse(next[key]).success) {
        AppStateSchema.parse(next);
      }
    }
    if (mergesLayouts && next.layoutByWorkspace) {
      const layouts = { ...this.state.layoutByWorkspace, ...next.layoutByWorkspace };
      next.layoutByWorkspace = workspaceIds ? pickWorkspaceLayouts(layouts, workspaceIds) : layouts;
    }
    return next;
  }

  flushNow(): void {
    if (this.revision === this.writtenRevision) return;
    try {
      this.writeNow(this.state);
      this.markWritten(this.revision);
    } catch (error) {
      this.scheduleWrite(RETRY_DELAY_MS);
      throw error;
    }
  }

  keepForNextLaunch(): void {
    writeStateFile(this.pendingPath, `${this.pendingPath}.vsctmp`, this.state, {
      rename: renameWhenUnlocked,
    });
    this.pendingRevision = this.revision;
  }

  private markWritten(revision: number): void {
    this.writtenRevision = Math.max(this.writtenRevision, revision);
    if (this.pendingRevision === undefined || revision < this.pendingRevision) return;
    try {
      fs.unlinkSync(this.pendingPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return;
    }
    this.pendingRevision = undefined;
  }

  private writeNow(state: AppState): void {
    const writing = this.writing;
    if (writing) {
      const phase = Atomics.compareExchange(writing, 0, PREPARING, CANCELLED);
      if (
        phase === RENAMING &&
        Atomics.wait(writing, 0, RENAMING, RENAME_WAIT_MS) === "timed-out"
      ) {
        throw new Error("Timed out waiting for the earlier app state rename");
      }
    }
    writeStateFile(this.filePath, `${this.filePath}.vsctmp.sync`, state, {
      rename: renameWhenUnlocked,
    });
    clearTimeout(this.timer);
    this.timer = undefined;
    this.retryDelay = RETRY_DELAY_MS;
  }

  private scheduleWrite(delay: number): void {
    if (this.timer || this.writing || this.revision === this.writtenRevision) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.write();
    }, delay);
    this.timer.unref();
  }

  private async write(): Promise<void> {
    const revision = this.revision;
    let delay = WRITE_DELAY_MS;
    try {
      if (this.useSyncWriter) {
        this.writeNow(this.state);
        this.markWritten(revision);
      } else {
        const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
        this.writing = gate;
        const written = await this.writer.write(this.state, gate);
        this.workerFailures = 0;
        if (written) this.markWritten(revision);
      }
      this.retryDelay = RETRY_DELAY_MS;
    } catch (error) {
      if (error instanceof StateWorkerError) {
        this.workerFailures++;
        if (error.startup || this.workerFailures >= MAX_WORKER_FAILURES) {
          this.useSyncWriter = true;
          log.warn(
            `App state worker unavailable; using synchronous writes: ${errnoText(error) ?? String(error)}`,
          );
          return;
        }
      } else {
        this.workerFailures = 0;
      }
      log.warn(`Could not save app state; retrying: ${errnoText(error) ?? String(error)}`);
      delay = this.retryDelay;
      this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_DELAY_MS);
    } finally {
      this.writing = undefined;
      this.scheduleWrite(delay);
    }
  }
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "unknown";
}

function salvageAppState(raw: unknown, empty: AppState): AppState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return empty;
  const source = raw as Record<string, unknown>;
  const salvaged: Record<string, unknown> = { ...empty };
  for (const [key, schema] of Object.entries(AppStateSchema.shape)) {
    if (!(key in source)) continue;
    const field = salvageField(schema, source[key]);
    if (field.ok) salvaged[key] = field.value;
  }
  return AppStateSchema.parse(salvaged);
}

function salvageField(
  schema: z.ZodType,
  value: unknown,
): { ok: true; value: unknown } | { ok: false } {
  const direct = schema.safeParse(value);
  if (direct.success) return { ok: true, value: direct.data };
  const inner = schema instanceof z.ZodOptional ? schema.unwrap() : schema;
  if (!(inner instanceof z.ZodRecord) || typeof value !== "object" || value === null) {
    return { ok: false };
  }
  const kept: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    const entry = inner.safeParse({ [entryKey]: entryValue });
    if (entry.success) Object.assign(kept, entry.data);
  }
  return { ok: true, value: kept };
}
