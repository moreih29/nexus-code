/**
 * Downloads that nexus commands start, as an agent opening a file's URL. They
 * are saved in a folder of the app's own under the system's temp folder, not
 * the user's Downloads, and the command's output tells where.
 *
 * A download is a command's when it starts while a command drives its tab or
 * within DRIVE_GRACE_MS after: Chromium starts one only after the load that
 * led to it has stopped, and a click's comes after the click has returned.
 * One the user starts in that window is taken for the command's.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DownloadItem } from "electron";
import { claimDownload, saveIn } from "../../browser/downloads";

export const DRIVE_GRACE_MS = 3_000;
/** How long a command's download is kept. */
export const DOWNLOAD_KEEP_MS = 24 * 60 * 60 * 1000;

/** The tabs nexus commands drive now or did a moment ago. */
export class DrivenTabs<Tab extends object> {
  private readonly tabs = new WeakMap<Tab, { running: number; until: number }>();

  /** Notes a command driving `tab`; call what it returns when the command is done. */
  begin(tab: Tab, now: () => number = Date.now): () => void {
    const entry = this.tabs.get(tab) ?? { running: 0, until: 0 };
    entry.running += 1;
    this.tabs.set(tab, entry);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      entry.running -= 1;
      entry.until = now() + DRIVE_GRACE_MS;
    };
  }

  drives(tab: Tab, now: number = Date.now()): boolean {
    const entry = this.tabs.get(tab);
    return entry !== undefined && (entry.running > 0 || now < entry.until);
  }
}

export function cliDownloadDir(): string {
  return path.join(os.tmpdir(), "nexus-downloads");
}

/** Removes the files in `dir` older than DOWNLOAD_KEEP_MS. */
export function pruneDownloads(dir: string, now: number = Date.now()): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile() && now - stat.mtimeMs > DOWNLOAD_KEEP_MS) fs.unlinkSync(file);
    } catch {
      // Gone already, or in use: left for the next time.
    }
  }
}

/**
 * Saves `item`, a command's download, at a free path in the folder, after old
 * downloads there are removed, and returns the path. Runs inside
 * will-download, which takes its path synchronously.
 */
export function saveCommandDownload(item: DownloadItem, dir: string = cliDownloadDir()): string {
  pruneDownloads(dir);
  const file = saveIn(item, dir);
  claimDownload(item);
  return file;
}
