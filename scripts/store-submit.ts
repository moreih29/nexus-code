import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { STORE_PRODUCT_ID } from "../src/main/features/updates/microsoft-store";

export const PRODUCT_ID = STORE_PRODUCT_ID;

export const RELEASE_NOTES_MAX_LENGTH = 1500;

const ROOT_DIR = path.resolve(import.meta.dir, "..");
const DEFAULT_NOTES_FILE = path.join(ROOT_DIR, "build", "store-release-notes.json");

const UPLOAD_TIMEOUT_SECONDS = "1800";

interface StoreListing {
  readonly BaseListing?: { readonly ReleaseNotes?: string } & Record<string, unknown>;
}

interface StorePackage {
  readonly FileName?: string;
  readonly FileStatus?: string;
}

export interface StoreSubmission {
  readonly Listings?: Readonly<Record<string, StoreListing>>;
  readonly ApplicationPackages?: readonly StorePackage[];
  readonly [key: string]: unknown;
}

export function readReleaseNotes(file: string, version: string): Record<string, string> {
  const { version: notesVersion, ...notes } = JSON.parse(readFileSync(file, "utf8")) as Record<
    string,
    unknown
  >;
  if (notesVersion !== version) {
    throw new Error(`${file} has the release notes of ${String(notesVersion)}, not ${version}`);
  }
  const locales = Object.keys(notes);
  if (locales.length === 0) throw new Error(`${file} has no release notes`);
  for (const locale of locales) {
    const text = notes[locale];
    if (typeof text !== "string" || text.trim() === "") {
      throw new Error(`${file}: the ${locale} release notes are empty`);
    }
    if (text.length > RELEASE_NOTES_MAX_LENGTH) {
      throw new Error(
        `${file}: the ${locale} release notes are ${text.length} characters, over the Store's ${RELEASE_NOTES_MAX_LENGTH}`,
      );
    }
  }
  return notes as Record<string, string>;
}

export function applyReleaseNotes(
  submission: StoreSubmission,
  notes: Readonly<Record<string, string>>,
): StoreSubmission {
  const listings = submission.Listings ?? {};
  const locales = Object.keys(listings);
  if (locales.length === 0) throw new Error("the submission has no listings");
  const missing = locales.filter((locale) => notes[locale] === undefined);
  if (missing.length > 0) throw new Error(`no release notes for the ${missing.join(", ")} listing`);
  const unknown = Object.keys(notes).filter((locale) => listings[locale] === undefined);
  if (unknown.length > 0) {
    throw new Error(
      `release notes for ${unknown.join(", ")}, which the submission has no listing for`,
    );
  }
  return {
    ...submission,
    Listings: Object.fromEntries(
      locales.map((locale) => [
        locale,
        {
          ...listings[locale],
          BaseListing: { ...listings[locale]?.BaseListing, ReleaseNotes: notes[locale] },
        },
      ]),
    ),
  };
}

export function checkDraftPackage(submission: StoreSubmission, fileName: string): void {
  const kept = (submission.ApplicationPackages ?? []).filter(
    (pkg) => pkg.FileStatus !== "PendingDelete",
  );
  if (kept.length !== 1 || kept[0]?.FileName !== fileName) {
    const names = kept.map((pkg) => `${pkg.FileName} (${pkg.FileStatus})`).join(", ") || "none";
    throw new Error(`the draft should keep only ${fileName}, but keeps ${names}`);
  }
}

export function findPackage(dir: string, version: string): string {
  const appxs = readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".appx"));
  const matching = appxs.filter((name) => name.includes(`-${version}-`));
  if (appxs.length !== 1 || matching.length !== 1) {
    throw new Error(
      `${dir} should hold one AppX of ${version}, but holds: ${appxs.join(", ") || "none"}`,
    );
  }
  return matching[0] as string;
}

function msstore(args: readonly string[]): string {
  const command = process.env.MSSTORE ?? "msstore";
  console.error(`> msstore ${args.join(" ")}`);
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    throw new Error(`msstore ${args[0]} ${args[1] ?? ""} exited ${result.status}`);
  }
  return result.stdout;
}

function getSubmission(): StoreSubmission {
  return JSON.parse(msstore(["submission", "get", PRODUCT_ID])) as StoreSubmission;
}

function printReleaseNotes(submission: StoreSubmission): void {
  for (const [locale, listing] of Object.entries(submission.Listings ?? {})) {
    console.log(`[${locale}]\n${listing.BaseListing?.ReleaseNotes ?? ""}\n`);
  }
}

interface SubmitOptions {
  readonly packageDir: string;
  readonly version: string;
  readonly notesFile: string;
  readonly commit: boolean;
  readonly dryRun: boolean;
}

export async function submitToStore(options: SubmitOptions): Promise<void> {
  const notes = readReleaseNotes(options.notesFile, options.version);
  const packageName = findPackage(options.packageDir, options.version);

  if (options.dryRun) {
    printReleaseNotes(applyReleaseNotes(getSubmission(), notes));
    console.log(`Dry run: would submit ${packageName} with the release notes above.`);
    return;
  }

  const scratch = mkdtempSync(path.join(os.tmpdir(), "nexus-store-"));
  try {
    writeFileSync(
      path.join(scratch, "package.json"),
      `${JSON.stringify({ name: "nexuscode-store", private: true })}\n`,
    );
    msstore([
      "publish",
      scratch,
      "--inputDirectory",
      path.resolve(options.packageDir),
      "--appId",
      PRODUCT_ID,
      "--noCommit",
      "--uploadTimeout",
      UPLOAD_TIMEOUT_SECONDS,
    ]);

    const draft = getSubmission();
    checkDraftPackage(draft, packageName);
    const payload = path.join(scratch, "submission.json");
    writeFileSync(payload, JSON.stringify(applyReleaseNotes(draft, notes)));
    msstore(["submission", "update", PRODUCT_ID, "--payload", payload]);

    const updated = getSubmission();
    for (const [locale, text] of Object.entries(notes)) {
      if (updated.Listings?.[locale]?.BaseListing?.ReleaseNotes !== text) {
        throw new Error(`the draft's ${locale} release notes did not take`);
      }
    }
    printReleaseNotes(updated);

    if (!options.commit) {
      console.log(`Left ${packageName} in a draft submission, not submitted.`);
      return;
    }
    msstore(["submission", "publish", PRODUCT_ID]);
    process.stdout.write(msstore(["submission", "poll", PRODUCT_ID]));
    console.log(`Submitted ${packageName} for certification.`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function parseCliArgs(argv: readonly string[]): SubmitOptions {
  let packageDir: string | undefined;
  let version: string | undefined;
  let notesFile = DEFAULT_NOTES_FILE;
  let commit = true;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--package-dir") packageDir = requiredValue(argv, ++index, arg);
    else if (arg === "--version") version = requiredValue(argv, ++index, arg);
    else if (arg === "--notes") notesFile = path.resolve(requiredValue(argv, ++index, arg));
    else if (arg === "--no-commit") commit = false;
    else if (arg === "--dry-run") dryRun = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!packageDir) throw new Error("--package-dir is required");
  return {
    packageDir,
    version: version ?? readAppVersion(),
    notesFile,
    commit,
    dryRun,
  };
}

function readAppVersion(): string {
  const { version } = JSON.parse(readFileSync(path.join(ROOT_DIR, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof version !== "string") throw new Error("package.json has no version");
  return version;
}

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

if (import.meta.main) {
  submitToStore(parseCliArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
