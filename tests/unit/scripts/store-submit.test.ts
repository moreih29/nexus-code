import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyReleaseNotes,
  checkDraftPackage,
  findPackage,
  RELEASE_NOTES_MAX_LENGTH,
  readReleaseNotes,
  type StoreSubmission,
} from "../../../scripts/store-submit";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "store-submit-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeNotes(contents: unknown): string {
  const file = path.join(makeTempRoot(), "notes.json");
  writeFileSync(file, JSON.stringify(contents));
  return file;
}

// The shape `msstore submission get` prints, cut down.
function submission(): StoreSubmission {
  return {
    Id: "1152921505702274229",
    Pricing: { PriceId: "Free" },
    Listings: {
      "en-us": {
        BaseListing: { Title: "NexusCode", ReleaseNotes: "The first version for Windows." },
      },
      "ko-kr": { BaseListing: { Title: "NexusCode", ReleaseNotes: "Windows용 첫 버전입니다." } },
    },
    ApplicationPackages: [
      { FileName: "NexusCode-0.11.0-x64.appx", FileStatus: "PendingDelete" },
      { FileName: "NexusCode-0.12.0-x64.appx", FileStatus: "PendingUpload" },
    ],
  };
}

describe("readReleaseNotes", () => {
  test("returns the notes by locale", () => {
    const file = writeNotes({ version: "0.12.0", "ko-kr": "새 기능", "en-us": "New" });
    expect(readReleaseNotes(file, "0.12.0")).toEqual({ "ko-kr": "새 기능", "en-us": "New" });
  });

  test("rejects the notes of another version", () => {
    const file = writeNotes({ version: "0.11.0", "ko-kr": "새 기능", "en-us": "New" });
    expect(() => readReleaseNotes(file, "0.12.0")).toThrow("not 0.12.0");
  });

  test("rejects empty notes", () => {
    const file = writeNotes({ version: "0.12.0", "ko-kr": " ", "en-us": "New" });
    expect(() => readReleaseNotes(file, "0.12.0")).toThrow("ko-kr release notes are empty");
  });

  test("rejects notes over the Store's limit", () => {
    const file = writeNotes({
      version: "0.12.0",
      "en-us": "a".repeat(RELEASE_NOTES_MAX_LENGTH + 1),
    });
    expect(() => readReleaseNotes(file, "0.12.0")).toThrow("over the Store's");
  });

  test("rejects a file with no notes", () => {
    const file = writeNotes({ version: "0.12.0" });
    expect(() => readReleaseNotes(file, "0.12.0")).toThrow("no release notes");
  });
});

describe("applyReleaseNotes", () => {
  test("sets each listing's notes and keeps everything else", () => {
    const original = submission();
    const updated = applyReleaseNotes(original, { "ko-kr": "새 기능", "en-us": "New" });
    expect(updated.Listings?.["ko-kr"]?.BaseListing).toEqual({
      Title: "NexusCode",
      ReleaseNotes: "새 기능",
    });
    expect(updated.Listings?.["en-us"]?.BaseListing).toEqual({
      Title: "NexusCode",
      ReleaseNotes: "New",
    });
    expect(updated.Pricing).toEqual({ PriceId: "Free" });
    expect(updated.ApplicationPackages).toEqual(original.ApplicationPackages);
    expect(original.Listings?.["ko-kr"]?.BaseListing?.ReleaseNotes).toBe(
      "Windows용 첫 버전입니다.",
    );
  });

  test("needs notes for every listing", () => {
    expect(() => applyReleaseNotes(submission(), { "en-us": "New" })).toThrow("ko-kr listing");
  });

  test("rejects notes for a locale the submission has no listing for", () => {
    expect(() =>
      applyReleaseNotes(submission(), { "ko-kr": "새 기능", "en-us": "New", "ja-jp": "新" }),
    ).toThrow("ja-jp");
  });

  test("rejects a submission with no listings", () => {
    expect(() => applyReleaseNotes({ Listings: {} }, { "en-us": "New" })).toThrow("no listings");
  });
});

describe("checkDraftPackage", () => {
  test("passes when the new package is the only one kept", () => {
    expect(() => checkDraftPackage(submission(), "NexusCode-0.12.0-x64.appx")).not.toThrow();
  });

  test("fails when the old package is still kept", () => {
    const draft: StoreSubmission = {
      ApplicationPackages: [
        { FileName: "NexusCode-0.11.0-x64.appx", FileStatus: "Uploaded" },
        { FileName: "NexusCode-0.12.0-x64.appx", FileStatus: "PendingUpload" },
      ],
    };
    expect(() => checkDraftPackage(draft, "NexusCode-0.12.0-x64.appx")).toThrow(
      "NexusCode-0.11.0-x64.appx (Uploaded)",
    );
  });

  test("fails when the new package is missing", () => {
    const draft: StoreSubmission = {
      ApplicationPackages: [{ FileName: "NexusCode-0.11.0-x64.appx", FileStatus: "Uploaded" }],
    };
    expect(() => checkDraftPackage(draft, "NexusCode-0.12.0-x64.appx")).toThrow(
      "keeps NexusCode-0.11.0",
    );
  });
});

describe("findPackage", () => {
  test("finds the AppX of the version", () => {
    const dir = makeTempRoot();
    writeFileSync(path.join(dir, "NexusCode-0.12.0-x64.appx"), "");
    expect(findPackage(dir, "0.12.0")).toBe("NexusCode-0.12.0-x64.appx");
  });

  test("rejects an AppX of another version", () => {
    const dir = makeTempRoot();
    writeFileSync(path.join(dir, "NexusCode-0.11.0-x64.appx"), "");
    expect(() => findPackage(dir, "0.12.0")).toThrow("NexusCode-0.11.0-x64.appx");
  });

  test("rejects more than one AppX", () => {
    const dir = makeTempRoot();
    writeFileSync(path.join(dir, "NexusCode-0.12.0-x64.appx"), "");
    writeFileSync(path.join(dir, "NexusCode-0.12.0-arm64.appx"), "");
    expect(() => findPackage(dir, "0.12.0")).toThrow("one AppX");
  });
});

describe("build/store-release-notes.json", () => {
  test("holds this version's notes", () => {
    const root = path.resolve(import.meta.dir, "../../..");
    const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(() =>
      readReleaseNotes(path.join(root, "build/store-release-notes.json"), version),
    ).not.toThrow();
  });
});
