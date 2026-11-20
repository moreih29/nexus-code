/**
 * Reads and writes a profile's behavior settings in the agent's own config
 * file in the profile's folder: settings.json (Claude), config.toml (Codex).
 * It is the file the agent reads and its own /config writes, so both always
 * show the same values. Only the keys the user changed are touched; a file
 * that does not parse is never overwritten; a file the folder shares with
 * the default folder (a link) is written through the link.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  BEHAVIOR_FIELDS,
  BEHAVIOR_FILE,
  type BehaviorChanges,
  type BehaviorField,
  type BehaviorFile,
  type BehaviorValue,
  type BehaviorWriteResult,
} from "../../../shared/agent-profiles/behavior";
import type { AgentProfile } from "../../../shared/agent-profiles/profiles";
import { localDefaultDir, localProfileDir, prepareLocalProfile } from "./local";
import { checkToml, editToml, readTomlKey, type TomlEdit } from "./toml-edit";

const MISSING = "missing";

function versionOf(text: string | null): string {
  return text === null ? MISSING : createHash("sha1").update(text).digest("hex");
}

/** The behavior file of the profile, in its folder (the default folder's for the default profile). */
export function behaviorFilePath(profile: AgentProfile): string {
  return path.join(localProfileDir(profile), BEHAVIOR_FILE[profile.agent]);
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Whether the profile's file is the default folder's own: a link to it, symbolic or hard. */
async function sharedWithDefault(profile: AgentProfile, file: string): Promise<boolean> {
  if (profile.dir.trim() === "") return false;
  const theirs = path.join(localDefaultDir(profile.agent), BEHAVIOR_FILE[profile.agent]);
  const [own, other] = await Promise.all([
    fs.stat(file, { bigint: true }).catch(() => null),
    fs.stat(theirs, { bigint: true }).catch(() => null),
  ]);
  if (!own || !other) return false;
  if (own.ino !== 0n && own.ino === other.ino && own.dev === other.dev) return true;
  const [a, b] = await Promise.all([
    fs.realpath(file).catch(() => file),
    fs.realpath(theirs).catch(() => theirs),
  ]);
  return a === b;
}

// ---------------------------------------------------------------------------
// JSON (settings.json)
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The parsed settings.json; throws with the reason when it is not a JSON object. */
function parseJson(text: string): JsonObject {
  if (text.trim() === "") return {};
  const parsed: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (!isObject(parsed)) throw new Error("the top level is not an object");
  return parsed;
}

/** The indent the file uses, to write it back the same way. */
function jsonIndent(text: string): string | number {
  const match = /^[ \t]+(?=")/m.exec(text);
  return match ? match[0] : 2;
}

type Found = { state: "absent" } | { state: "value"; value: unknown } | { state: "unsupported" };

function jsonGet(root: JsonObject, keys: readonly string[]): Found {
  let node: unknown = root;
  for (const [n, key] of keys.entries()) {
    if (!isObject(node)) return { state: "unsupported" };
    if (!(key in node)) return { state: "absent" };
    node = node[key];
    if (n === keys.length - 1) return { state: "value", value: node };
  }
  return { state: "absent" };
}

function jsonSet(
  root: JsonObject,
  keys: readonly string[],
  value: BehaviorValue | undefined,
): boolean {
  const parents: JsonObject[] = [root];
  for (const key of keys.slice(0, -1)) {
    const next = (parents[parents.length - 1] as JsonObject)[key];
    if (next === undefined) {
      if (value === undefined) return true;
      const made: JsonObject = {};
      (parents[parents.length - 1] as JsonObject)[key] = made;
      parents.push(made);
    } else if (isObject(next)) parents.push(next);
    else return false;
  }
  const last = keys[keys.length - 1] as string;
  const holder = parents[parents.length - 1] as JsonObject;
  if (value === undefined) delete holder[last];
  else holder[last] = value;
  // A table this emptied goes too.
  for (let n = parents.length - 1; n > 0; n--) {
    if (Object.keys(parents[n] as JsonObject).length > 0) break;
    delete (parents[n - 1] as JsonObject)[keys[n - 1] as string];
  }
  return true;
}

/** Commit and PR attribution: off when both texts are empty (or the legacy includeCoAuthoredBy is false). */
function readAttribution(root: JsonObject): BehaviorValue | undefined | "unsupported" {
  const attr = root.attribution;
  if (attr !== undefined && !isObject(attr)) return "unsupported";
  const legacyOff = root.includeCoAuthoredBy === false;
  if (attr === undefined && root.includeCoAuthoredBy === undefined) return undefined;
  const hidden = (text: unknown) => text === "" || (text === undefined && legacyOff);
  return !(hidden(attr?.commit) && hidden(attr?.pr));
}

function writeAttribution(root: JsonObject, on: boolean): boolean {
  const attr = root.attribution;
  if (attr !== undefined && !isObject(attr)) return false;
  const next: JsonObject = { ...(attr ?? {}) };
  if (on) {
    if (next.commit === "") delete next.commit;
    if (next.pr === "") delete next.pr;
    if (root.includeCoAuthoredBy === false) delete root.includeCoAuthoredBy;
  } else {
    next.commit = "";
    next.pr = "";
  }
  if (Object.keys(next).length === 0) delete root.attribution;
  else root.attribution = next;
  return true;
}

function matches(field: BehaviorField, value: unknown): value is BehaviorValue {
  if (field.kind === "bool") return typeof value === "boolean";
  if (field.kind === "int") return typeof value === "number" && Number.isInteger(value);
  return typeof value === "string";
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function fieldsOf(agent: AgentProfile["agent"]): readonly BehaviorField[] {
  return BEHAVIOR_FIELDS.filter((f) => f.agent === agent);
}

function readFields(
  agent: AgentProfile["agent"],
  text: string,
): { values: Record<string, BehaviorValue>; unsupported: string[] } {
  const values: Record<string, BehaviorValue> = {};
  const unsupported: string[] = [];
  const root = agent === "claude" ? parseJson(text) : null;
  for (const field of fieldsOf(agent)) {
    let found: Found;
    if (root && field.id === "attribution") {
      const read = readAttribution(root);
      found =
        read === "unsupported"
          ? { state: "unsupported" }
          : read === undefined
            ? { state: "absent" }
            : { state: "value", value: read };
    } else if (root) found = jsonGet(root, field.path);
    else {
      const read = readTomlKey(text, field.path);
      found = read.state === "value" ? { state: "value", value: read.value } : read;
    }
    if (found.state === "absent") continue;
    if (found.state === "unsupported" || !matches(field, found.value)) unsupported.push(field.id);
    else values[field.id] = found.value;
  }
  return { values, unsupported };
}

/** The names of the output styles in the folder's output-styles: a `name:` in the front matter, else the file's name. */
async function readOutputStyles(profile: AgentProfile): Promise<string[]> {
  if (profile.agent !== "claude") return [];
  const dir = path.join(localProfileDir(profile), "output-styles");
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const names: string[] = [];
  for (const file of files.filter((f) => f.endsWith(".md")).sort()) {
    const head = await fs
      .readFile(path.join(dir, file), "utf8")
      .then((t) => t.slice(0, 2000))
      .catch(() => "");
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head)?.[1] ?? "";
    const named = /^name:\s*["']?(.+?)["']?\s*$/m.exec(front)?.[1];
    names.push(named ?? file.slice(0, -3));
  }
  return names;
}

/** The profile's file as it is now. `prepare` first makes the folder and its links, for a profile that has them. */
export async function readBehavior(
  profile: AgentProfile,
  opts: { prepare?: boolean } = {},
): Promise<BehaviorFile> {
  if (opts.prepare && profile.dir.trim() !== "") await prepareLocalProfile(profile).catch(() => {});
  const file = behaviorFilePath(profile);
  const text = await readText(file);
  const base = {
    outputStyles: await readOutputStyles(profile),
    path: file,
    name: BEHAVIOR_FILE[profile.agent],
    exists: text !== null,
    shared: await sharedWithDefault(profile, file),
    version: versionOf(text),
  };
  if (text === null) return { ...base, broken: null, values: {}, unsupported: [] };
  try {
    if (profile.agent === "codex") {
      const reason = checkToml(text);
      if (reason) return { ...base, broken: reason, values: {}, unsupported: [] };
    }
    return { ...base, broken: null, ...readFields(profile.agent, text) };
  } catch (error) {
    return { ...base, broken: (error as Error).message, values: {}, unsupported: [] };
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** What a change means for the file: the value to write, or undefined to remove the key. */
function normalize(field: BehaviorField, value: BehaviorValue | null): BehaviorValue | undefined {
  if (value === null) return undefined;
  if (!matches(field, value)) throw new Error(`${field.id}: not a ${field.kind}`);
  if (field.kind === "int" && typeof value === "number" && value < 0)
    throw new Error(`${field.id}: negative`);
  if (value === "" || value === field.fallback) return undefined;
  return value;
}

/**
 * Where a write to `file` goes: through a symbolic link to the file it leads
 * to, so the link stays; a hard link is written in place, as a new file
 * would take it off the other name.
 */
async function writeTarget(
  file: string,
): Promise<{ target: string; inPlace: boolean; mode: number }> {
  let target = file;
  const link = await fs.lstat(file).catch(() => null);
  if (link?.isSymbolicLink()) {
    target = await fs.realpath(file).catch(async () => {
      // A link to a file that is not there yet: the file it names.
      return path.resolve(path.dirname(file), await fs.readlink(file));
    });
  }
  const stat = await fs.stat(target).catch(() => null);
  return {
    target,
    inPlace: stat !== null && stat.nlink > 1,
    mode: stat ? stat.mode & 0o777 : 0o600,
  };
}

async function replaceFile(file: string, text: string): Promise<void> {
  const { target, inPlace, mode } = await writeTarget(file);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  if (inPlace) {
    await fs.writeFile(target, text, "utf8");
    return;
  }
  const temp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await fs.writeFile(temp, text, { encoding: "utf8", mode });
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function applyJson(
  text: string,
  changes: Map<BehaviorField, BehaviorValue | undefined>,
): { text: string } | { unsupported: string } {
  const root = parseJson(text);
  for (const [field, value] of changes) {
    const done =
      field.id === "attribution"
        ? writeAttribution(root, value !== false)
        : jsonSet(root, field.path, value);
    if (!done) return { unsupported: field.id };
  }
  const body = JSON.stringify(root, null, jsonIndent(text));
  return { text: text === "" || text.endsWith("\n") ? `${body}\n` : body };
}

/**
 * Writes the changes (a field's new value, or null for its default) into the
 * file, if the file is still what `version` was read from.
 */
export async function writeBehavior(
  profile: AgentProfile,
  version: string,
  changes: BehaviorChanges,
): Promise<BehaviorWriteResult> {
  const fields = new Map<BehaviorField, BehaviorValue | undefined>();
  for (const [id, value] of Object.entries(changes)) {
    const field = fieldsOf(profile.agent).find((f) => f.id === id);
    if (!field) throw new Error(`unknown field ${id}`);
    // The attribution switch is its own off/on: its default is "on", written as no key.
    fields.set(
      field,
      field.id === "attribution" ? (value === null ? true : value) : normalize(field, value),
    );
  }
  // A shared file not linked yet is linked first, so the write goes to the shared one.
  if (profile.dir.trim() !== "") await prepareLocalProfile(profile).catch(() => {});
  const file = behaviorFilePath(profile);
  const text = await readText(file);
  if (versionOf(text) !== version) return { status: "conflict" };
  const current = text ?? "";
  let next: string;
  try {
    if (profile.agent === "claude") {
      const done = applyJson(current, fields);
      if ("unsupported" in done) return { status: "unsupported", fields: [done.unsupported] };
      next = done.text;
    } else {
      const reason = checkToml(current);
      if (reason) return { status: "broken", message: reason };
      const edits: TomlEdit[] = [...fields].map(([field, value]) => ({ path: field.path, value }));
      const done = editToml(current, edits);
      if (!done.ok) {
        if (done.reason === "broken") return { status: "broken", message: done.message };
        const ids = fieldsOf("codex")
          .filter((f) => done.path && f.path.join(".") === done.path.join("."))
          .map((f) => f.id);
        return { status: "unsupported", fields: ids };
      }
      next = done.text;
    }
  } catch (error) {
    return { status: "broken", message: (error as Error).message };
  }
  if (next !== current) await replaceFile(file, next);
  return { status: "saved", version: versionOf(next === current ? text : next) };
}

/**
 * Makes the profile's file its own: the content now (through the link) is
 * copied to a file of the profile's folder in the link's place. The default
 * folder's file is not touched. No-op when the file is not shared.
 */
export async function unshareBehaviorFile(profile: AgentProfile): Promise<{ path: string }> {
  const file = behaviorFilePath(profile);
  if (!(await sharedWithDefault(profile, file))) return { path: file };
  const text = await fs.readFile(file);
  const mode = (await fs.stat(file)).mode & 0o777;
  const temp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await fs.writeFile(temp, text, { mode });
    // Renaming over the name replaces the link itself, not the file it leads to.
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return { path: file };
}
