/**
 * Downloads a nexus command starts are saved in the app's temp folder under
 * a free name, kept a day, and are the command's only while it drives the
 * tab or just after.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DownloadItem } from "electron";
import {
  DOWNLOAD_KEEP_MS,
  DRIVE_GRACE_MS,
  DrivenTabs,
  pruneDownloads,
  saveCommandDownload,
} from "../../../../../src/main/features/cli/browser/downloads";

function makeItem(name: string) {
  const item = new EventEmitter() as EventEmitter & {
    savePath: string;
    getFilename: () => string;
    setSavePath: (p: string) => void;
  };
  item.savePath = "";
  item.getFilename = () => name;
  item.setSavePath = (p) => {
    item.savePath = p;
  };
  return item;
}

describe("DrivenTabs", () => {
  test("drives a tab while a command runs and for the grace after", () => {
    const tabs = new DrivenTabs<object>();
    const tab = {};
    let now = 1_000;
    expect(tabs.drives(tab, now)).toBe(false);
    const done = tabs.begin(tab, () => now);
    now += 60_000;
    expect(tabs.drives(tab, now)).toBe(true);
    done();
    expect(tabs.drives(tab, now + DRIVE_GRACE_MS - 1)).toBe(true);
    expect(tabs.drives(tab, now + DRIVE_GRACE_MS)).toBe(false);
  });

  test("keeps driving while another command on the tab still runs", () => {
    const tabs = new DrivenTabs<object>();
    const tab = {};
    const now = 1_000;
    const first = tabs.begin(tab, () => now);
    const second = tabs.begin(tab, () => now);
    first();
    first();
    expect(tabs.drives(tab, now + DRIVE_GRACE_MS + 1)).toBe(true);
    second();
    expect(tabs.drives(tab, now + DRIVE_GRACE_MS + 1)).toBe(false);
  });

  test("tells tabs apart", () => {
    const tabs = new DrivenTabs<object>();
    tabs.begin({});
    expect(tabs.drives({})).toBe(false);
  });
});

describe("the download folder", () => {
  const dirs: string[] = [];
  const makeDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-downloads-test-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("removes downloads older than a day and keeps newer ones", () => {
    const dir = makeDir();
    const now = Date.now();
    fs.writeFileSync(path.join(dir, "old.md"), "x");
    fs.writeFileSync(path.join(dir, "new.md"), "x");
    const old = (now - DOWNLOAD_KEEP_MS - 1000) / 1000;
    fs.utimesSync(path.join(dir, "old.md"), old, old);
    pruneDownloads(dir, now);
    expect(fs.readdirSync(dir)).toEqual(["new.md"]);
  });

  test("saves each download at a path of its own, even before it is written", () => {
    const dir = path.join(makeDir(), "made");
    const first = makeItem("README.md");
    const second = makeItem("README.md");
    expect(saveCommandDownload(first as unknown as DownloadItem, dir)).toBe(
      path.join(dir, "README.md"),
    );
    expect(saveCommandDownload(second as unknown as DownloadItem, dir)).toBe(
      path.join(dir, "README (1).md"),
    );
    expect(fs.existsSync(dir)).toBe(true);
    expect(first.savePath).toBe(path.join(dir, "README.md"));
    expect(second.savePath).toBe(path.join(dir, "README (1).md"));
  });
});
