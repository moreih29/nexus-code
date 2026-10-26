import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  type AppState,
  AppStateSchema,
  type WindowBounds,
  WindowBoundsSchema,
} from "../../../shared/types/app-state";

export { type AppState, AppStateSchema, type WindowBounds, WindowBoundsSchema };

// ---------------------------------------------------------------------------
// StateService — atomic JSON persistence (pattern: vscode stateService.ts:141)
// Writes to a .vsctmp postfix file then renames atomically (POSIX rename).
// ---------------------------------------------------------------------------

export class StateService {
  private readonly filePath: string;
  private readonly tmpPath: string;
  private state: AppState;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.tmpPath = `${filePath}.vsctmp`;
    this.state = this.load();
  }

  private load(): AppState {
    // Parse an empty object first to materialise all `.default()` values.
    // This is the fallback used on first run or when the persisted file is
    // absent / corrupt.
    const empty = AppStateSchema.parse({});
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.backUpInvalidFile();
      return empty;
    }
    const parsed = AppStateSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    // One field the schema no longer accepts (a downgrade, a removed enum
    // value) must not cost the user every other setting: keep what still
    // validates, and keep the original file since the next flush replaces it.
    this.backUpInvalidFile();
    return salvageAppState(raw, empty);
  }

  private backUpInvalidFile(): void {
    try {
      fs.copyFileSync(this.filePath, `${this.filePath}.invalid`);
    } catch {
      // Best effort: the file may be unreadable, which is why we got here.
    }
  }

  getState(): Readonly<AppState> {
    return this.state;
  }

  setState(partial: Partial<AppState>): void {
    AppStateSchema.parse({ ...this.state, ...partial });
    this.state = { ...this.state, ...partial };
    this.flush();
  }

  mergeState(partial: Partial<AppState>): void {
    this.setState(partial);
  }

  /**
   * Synchronously flush the current in-memory state to disk.
   *
   * Exposed as a public API for callers that must guarantee durability before
   * a destructive operation (e.g. `app.relaunch`).  The underlying I/O is
   * synchronous (write + rename), so this method is safe to call without
   * awaiting in contexts that cannot wait for an async flush cycle.
   */
  flushNow(): void {
    this.flush();
  }

  private flush(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const serialized = JSON.stringify(this.state, null, 2);
    // fsync before the rename so a crash or power loss cannot leave the
    // renamed file empty.
    const fd = fs.openSync(this.tmpPath, "w");
    try {
      fs.writeSync(fd, serialized, null, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(this.tmpPath, this.filePath);
  }
}

/**
 * Rebuilds app state from a persisted object that failed validation as a
 * whole. Each top-level field is validated on its own; for record fields
 * (per-workspace layouts, LSP languages, permission grants) only the
 * invalid entries are dropped.
 */
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
  schema: z.ZodTypeAny,
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
