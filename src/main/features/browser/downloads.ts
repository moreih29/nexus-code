/**
 * Downloads in browser tabs. The user's are saved in the Downloads folder,
 * as a browser does without asking, and the app says so when one is done. A
 * download a nexus command started is claimed by the command instead, saved
 * elsewhere and told in its output, so the user is not told of it.
 */
import fs from "node:fs";
import path from "node:path";
import { app, type DownloadItem, type Session, type WebContents } from "electron";

const claimed = new WeakSet<DownloadItem>();
const noticed = new WeakSet<Session>();
/** Paths given to downloads not done yet, whose files are not there until then. */
const reserved = new Set<string>();

/** A path in `dir` for `file` that no file has, as "a (1).pdf" beside "a.pdf". */
export function freePath(dir: string, file: string, taken: (p: string) => boolean): string {
  const name = path.basename(file) || "download";
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let n = 1; taken(candidate); n++) candidate = path.join(dir, `${stem} (${n})${ext}`);
  return candidate;
}

/**
 * Saves `item` at a free path in `dir`, made if missing, and returns the
 * path. Called inside will-download, which takes the path synchronously; a
 * later call for the same item wins.
 */
export function saveIn(item: DownloadItem, dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = freePath(dir, item.getFilename(), (p) => reserved.has(p) || fs.existsSync(p));
  reserved.add(file);
  item.once("done", () => reserved.delete(file));
  item.setSavePath(file);
  return file;
}

/** Marks a download as a nexus command's, which the user is not told of. */
export function claimDownload(item: DownloadItem): void {
  claimed.add(item);
}

/**
 * Saves the downloads the user starts in `session`'s tabs to `dir`, and calls
 * `notify` with each one's file name once it is done. Tabs of a workspace
 * share a session, so it is watched once.
 */
export function noticeDownloads(
  session: Session,
  notify: (from: WebContents, file: string) => void,
  dir: () => string = () => app.getPath("downloads"),
): void {
  if (noticed.has(session)) return;
  noticed.add(session);
  session.on("will-download", (_event, item, from) => {
    // A command's listener may run before this one or after, and then saves
    // the item elsewhere over this path.
    if (!claimed.has(item)) saveIn(item, dir());
    item.once("done", (_done, state) => {
      if (state !== "completed" || claimed.has(item)) return;
      notify(from, path.basename(item.getSavePath()));
    });
  });
}
