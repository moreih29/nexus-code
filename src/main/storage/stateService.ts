import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// AppState schema
// ---------------------------------------------------------------------------

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AppState {
  windowBounds?: WindowBounds;
  lastActiveWorkspaceId?: string;
}

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
    this.tmpPath = filePath + ".vsctmp";
    this.state = this.load();
  }

  private load(): AppState {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      return JSON.parse(raw) as AppState;
    } catch {
      return {};
    }
  }

  getState(): Readonly<AppState> {
    return this.state;
  }

  setState(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial };
    this.flush();
  }

  mergeState(partial: Partial<AppState>): void {
    this.setState(partial);
  }

  private flush(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const serialized = JSON.stringify(this.state, null, 2);
    fs.writeFileSync(this.tmpPath, serialized, "utf8");
    fs.renameSync(this.tmpPath, this.filePath);
  }
}
