/**
 * The downloads the user starts in a browser tab are saved in the Downloads
 * folder without asking and told once done; the ones a nexus command claimed
 * are neither.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DownloadItem, Session, WebContents } from "electron";
import {
  claimDownload,
  freePath,
  noticeDownloads,
  saveIn,
} from "../../../../../src/main/features/browser/downloads";

const dirs: string[] = [];
function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-user-downloads-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeItem(name: string) {
  const item = new EventEmitter() as EventEmitter & {
    savePath: string;
    getFilename: () => string;
    getSavePath: () => string;
    setSavePath: (p: string) => void;
  };
  item.savePath = "";
  item.getFilename = () => name;
  item.getSavePath = () => item.savePath;
  item.setSavePath = (p) => {
    item.savePath = p;
  };
  return item;
}

function setup() {
  const dir = makeDir();
  const session = new EventEmitter();
  const told: string[] = [];
  noticeDownloads(
    session as unknown as Session,
    (_from, file) => told.push(file),
    () => dir,
  );
  const start = (item: ReturnType<typeof makeItem>) =>
    session.emit("will-download", {}, item, {} as WebContents);
  return { dir, session, told, start };
}

describe("freePath", () => {
  test("numbers the name before its extension until it is free", () => {
    const taken = new Set(["/d/a.pdf", "/d/a (1).pdf"]);
    expect(freePath("/d", "a.pdf", (p) => taken.has(p))).toBe("/d/a (2).pdf");
    expect(freePath("/d", "b.pdf", (p) => taken.has(p))).toBe("/d/b.pdf");
  });

  test("keeps a download's name out of other folders", () => {
    expect(freePath("/d", "../../etc/passwd", () => false)).toBe("/d/passwd");
    expect(freePath("/d", "", () => false)).toBe("/d/download");
  });
});

describe("saveIn", () => {
  test("holds a path until its download is done, then goes by the file", () => {
    const dir = path.join(makeDir(), "made");
    const first = makeItem("a.zip");
    expect(saveIn(first as unknown as DownloadItem, dir)).toBe(path.join(dir, "a.zip"));
    expect(fs.existsSync(dir)).toBe(true);
    expect(saveIn(makeItem("a.zip") as unknown as DownloadItem, dir)).toBe(
      path.join(dir, "a (1).zip"),
    );
    first.emit("done", {}, "cancelled");
    expect(saveIn(makeItem("a.zip") as unknown as DownloadItem, dir)).toBe(path.join(dir, "a.zip"));
  });
});

describe("noticeDownloads", () => {
  test("saves the user's download in the folder without asking and tells it once done", () => {
    const { dir, told, start } = setup();
    fs.writeFileSync(path.join(dir, "report.pdf"), "x");
    const item = makeItem("report.pdf");
    start(item);
    expect(item.savePath).toBe(path.join(dir, "report (1).pdf"));
    expect(told).toEqual([]);
    item.emit("done", {}, "completed");
    expect(told).toEqual(["report (1).pdf"]);
  });

  test("does not tell a cancelled or interrupted download", () => {
    const { told, start } = setup();
    const cancelled = makeItem("a.zip");
    const interrupted = makeItem("b.zip");
    start(cancelled);
    start(interrupted);
    cancelled.emit("done", {}, "cancelled");
    interrupted.emit("done", {}, "interrupted");
    expect(told).toEqual([]);
  });

  test("leaves a download a nexus command claimed first where the command saved it", () => {
    const { told, session } = setup();
    const item = makeItem("a.md");
    // The command's listener, added before this one.
    session.prependListener("will-download", (_event, claimedItem) => {
      claimedItem.setSavePath("/tmp/nexus-downloads/a.md");
      claimDownload(claimedItem);
    });
    session.emit("will-download", {}, item, {} as WebContents);
    expect(item.savePath).toBe("/tmp/nexus-downloads/a.md");
    item.emit("done", {}, "completed");
    expect(told).toEqual([]);
  });

  test("does not tell a download a nexus command claimed after it was saved", () => {
    const { told, start } = setup();
    const item = makeItem("a.md");
    start(item);
    item.setSavePath("/tmp/nexus-downloads/a.md");
    claimDownload(item as unknown as DownloadItem);
    item.emit("done", {}, "completed");
    expect(told).toEqual([]);
  });

  test("watches a session once, however many tabs share it", () => {
    const { session, told, start } = setup();
    noticeDownloads(session as unknown as Session, (_from, file) => told.push(`again ${file}`));
    const item = makeItem("x.txt");
    start(item);
    item.emit("done", {}, "completed");
    expect(told).toEqual(["x.txt"]);
  });
});
