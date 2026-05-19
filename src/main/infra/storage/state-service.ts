import fs from "node:fs";
import path from "node:path";
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
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = AppStateSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
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
    fs.writeFileSync(this.tmpPath, serialized, "utf8");
    fs.renameSync(this.tmpPath, this.filePath);
  }
}
