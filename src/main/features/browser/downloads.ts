import fs from "node:fs";
import path from "node:path";
import { app, type DownloadItem, type Session, type WebContents } from "electron";

const claimed = new WeakSet<DownloadItem>();
const noticed = new WeakSet<Session>();
const reserved = new Set<string>();

export function freePath(dir: string, file: string, taken: (p: string) => boolean): string {
  const name = path.basename(file) || "download";
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let n = 1; taken(candidate); n++) candidate = path.join(dir, `${stem} (${n})${ext}`);
  return candidate;
}

export function saveIn(item: DownloadItem, dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = freePath(dir, item.getFilename(), (p) => reserved.has(p) || fs.existsSync(p));
  reserved.add(file);
  item.once("done", () => reserved.delete(file));
  item.setSavePath(file);
  return file;
}

export function claimDownload(item: DownloadItem): void {
  claimed.add(item);
}

export function noticeDownloads(
  session: Session,
  notify: (from: WebContents, file: string) => void,
  dir: () => string = () => app.getPath("downloads"),
): void {
  if (noticed.has(session)) return;
  noticed.add(session);
  session.on("will-download", (_event, item, from) => {
    if (!claimed.has(item)) saveIn(item, dir());
    item.once("done", (_done, state) => {
      if (state !== "completed" || claimed.has(item)) return;
      notify(from, path.basename(item.getSavePath()));
    });
  });
}
