import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { HIDDEN_NAMES } from "../../shared/fs-defaults";
import { FS_WATCHER_DEBOUNCE_MS } from "../../shared/timing-constants";
import type { FsChange, FsChangeKind } from "../../shared/types/fs";
import type { BroadcastFn } from "../workspace/workspace-manager";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WatchEntry {
  workspaceId: string;
  workspaceRoot: string;
  watcher: FSWatcher;
}

// ---------------------------------------------------------------------------
// FileWatcher
//
// Maintains one chokidar FSWatcher per watched directory (depth: 0), so that
// each expand() call watches exactly one directory level without affecting
// sibling or parent watchers.  Using a single instance with multiple .add()
// calls is not viable here because chokidar's `depth` option is a global
// instance option — once set, it applies to every path added to that watcher.
// Directory-per-instance is the only clean way to enforce depth: 0 per directory.
// ---------------------------------------------------------------------------

export class FileWatcher {
  private readonly broadcast: BroadcastFn;

  // absDir -> WatchEntry
  private readonly entries = new Map<string, WatchEntry>();

  // workspaceId -> Map<relPath, FsChangeKind>  (change buffer)
  private readonly buffers = new Map<string, Map<string, FsChangeKind>>();

  // workspaceId -> pending debounce timer
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(broadcast: BroadcastFn) {
    this.broadcast = broadcast;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  watch(workspaceId: string, workspaceRoot: string, absDir: string): void {
    if (this.entries.has(absDir)) {
      return;
    }

    const watcher = chokidar.watch(absDir, {
      depth: 0,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: false,
      ignored: (p: string) => p !== absDir && HIDDEN_NAMES.has(path.basename(p)),
    });

    const handleEvent = (kind: FsChangeKind, absPath: string): void => {
      const basename = path.basename(absPath);
      if (HIDDEN_NAMES.has(basename)) {
        return;
      }
      const relPath = path.relative(workspaceRoot, absPath);
      this.buffer(workspaceId, relPath, kind);
    };

    watcher.on("add", (p) => handleEvent("added", p));
    watcher.on("addDir", (p) => {
      // depth:0 fires addDir for the watched dir itself on start — skip root
      if (p !== absDir) {
        handleEvent("added", p);
      }
    });
    watcher.on("change", (p) => handleEvent("modified", p));
    watcher.on("unlink", (p) => handleEvent("deleted", p));
    watcher.on("unlinkDir", (p) => handleEvent("deleted", p));

    this.entries.set(absDir, { workspaceId, workspaceRoot, watcher });
  }

  unwatch(workspaceId: string, absDir: string): void {
    const entry = this.entries.get(absDir);
    if (!entry || entry.workspaceId !== workspaceId) {
      return;
    }
    void entry.watcher.close();
    this.entries.delete(absDir);
  }

  disposeWorkspace(workspaceId: string): void {
    // Stop debounce timer
    const timer = this.timers.get(workspaceId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(workspaceId);
    }

    // Discard buffered changes
    this.buffers.delete(workspaceId);

    // Close all watchers for this workspace
    for (const [absDir, entry] of this.entries) {
      if (entry.workspaceId === workspaceId) {
        void entry.watcher.close();
        this.entries.delete(absDir);
      }
    }
  }

  dispose(): void {
    // Clear all timers
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.buffers.clear();

    // Close all watchers
    for (const entry of this.entries.values()) {
      void entry.watcher.close();
    }
    this.entries.clear();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private buffer(workspaceId: string, relPath: string, kind: FsChangeKind): void {
    let buf = this.buffers.get(workspaceId);
    if (!buf) {
      buf = new Map();
      this.buffers.set(workspaceId, buf);
    }
    // last-write-wins: if the same path fires multiple events within the
    // debounce window, keep only the most recent kind.
    buf.set(relPath, kind);

    const existing = this.timers.get(workspaceId);
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.timers.delete(workspaceId);
      this.flush(workspaceId);
    }, FS_WATCHER_DEBOUNCE_MS);

    this.timers.set(workspaceId, timer);
  }

  private flush(workspaceId: string): void {
    const buf = this.buffers.get(workspaceId);
    if (!buf || buf.size === 0) {
      return;
    }

    const changes: FsChange[] = Array.from(buf.entries()).map(([relPath, kind]) => ({
      relPath,
      kind,
    }));

    this.buffers.delete(workspaceId);

    this.broadcast("fs", "changed", { workspaceId, changes });
  }
}
