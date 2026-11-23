import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DownloadItem } from "electron";
import { claimDownload, saveIn } from "../../browser/downloads";

export const DRIVE_GRACE_MS = 3_000;
export const DOWNLOAD_KEEP_MS = 24 * 60 * 60 * 1000;

export class DrivenTabs<Tab extends object> {
  private readonly tabs = new WeakMap<Tab, { running: number; until: number }>();

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
    } catch {}
  }
}

export function saveCommandDownload(item: DownloadItem, dir: string = cliDownloadDir()): string {
  pruneDownloads(dir);
  const file = saveIn(item, dir);
  claimDownload(item);
  return file;
}
