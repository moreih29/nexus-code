import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceId } from "../../../shared/src/contracts/workspace";

const NEXUS_SOURCE = "nexus-code";
const CLAUDE_SETTINGS_RELATIVE_PATH = path.join(".claude", "settings.local.json");
const CLAUDE_SETTINGS_GITIGNORE_ENTRY = ".claude/settings.local.json";
const SETTINGS_VERSION = 1;

export type ClaudeHookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "Notification"
  | "Stop"
  | "StopFailure";

export interface ClaudeSettingsManagerOptions {
  sidecarBin: string;
  dataDir: string;
  now?: () => Date;
}

export interface ClaudeWorkspaceRegistration {
  workspaceId: WorkspaceId;
  workspacePath: string;
}

export interface ClaudeSettingsDetection {
  settingsPath: string;
  exists: boolean;
  nexusHookCount: number;
  gitignorePath: string;
  gitignoreIncludesSettings: boolean;
}

export interface ClaudeSettingsConsentRecord {
  workspaceId: WorkspaceId;
  dontAskAgain: boolean;
  updatedAt: string;
}

type JsonObject = Record<string, unknown>;

type ClaudeHookCommand = {
  type: "command";
  command: string;
  timeout: number;
  source: typeof NEXUS_SOURCE;
};

type ClaudeHookMatcher = {
  matcher?: string;
  hooks: Array<Record<string, unknown>>;
  source?: typeof NEXUS_SOURCE;
};

interface ClaudeSettingsFile extends JsonObject {
  hooks?: Record<string, ClaudeHookMatcher[]>;
}

const HOOK_EVENTS: ClaudeHookEventName[] = [
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
  "StopFailure",
];

export class ClaudeSettingsManager {
  private readonly sidecarBin: string;
  private readonly dataDir: string;
  private readonly now: () => Date;

  public constructor(options: ClaudeSettingsManagerOptions) {
    this.sidecarBin = options.sidecarBin;
    this.dataDir = options.dataDir;
    this.now = options.now ?? (() => new Date());
  }

  public async detectExisting(
    registration: ClaudeWorkspaceRegistration,
  ): Promise<ClaudeSettingsDetection> {
    const paths = workspaceClaudePaths(registration.workspacePath);
    const settings = await readSettings(paths.settingsPath);
    const gitignore = await readTextIfExists(paths.gitignorePath);

    return {
      settingsPath: paths.settingsPath,
      exists: settings.exists,
      nexusHookCount: settings.exists ? countNexusHooks(settings.value) : 0,
      gitignorePath: paths.gitignorePath,
      gitignoreIncludesSettings: gitignoreIncludesSettings(gitignore ?? ""),
    };
  }

  public async register(registration: ClaudeWorkspaceRegistration): Promise<ClaudeSettingsDetection> {
    const paths = workspaceClaudePaths(registration.workspacePath);
    await mkdir(paths.claudeDir, { recursive: true });

    const settings = await readSettings(paths.settingsPath);
    if (settings.exists) {
      await createBackupOnce(paths.settingsPath, paths.claudeDir, this.timestampSlug());
    }

    const nextSettings = mergeNexusHooks(
      settings.exists ? settings.value : {},
      buildHookCommands({
        sidecarBin: this.sidecarBin,
        dataDir: this.dataDir,
        workspaceId: registration.workspaceId,
      }),
    );
    await writeJson(paths.settingsPath, nextSettings);
    await ensureGitignoreEntry(paths.gitignorePath);

    return this.detectExisting(registration);
  }

  public async unregister(registration: ClaudeWorkspaceRegistration): Promise<ClaudeSettingsDetection> {
    const paths = workspaceClaudePaths(registration.workspacePath);
    const settings = await readSettings(paths.settingsPath);
    if (settings.exists) {
      await writeJson(paths.settingsPath, removeNexusHooks(settings.value));
    }
    return this.detectExisting(registration);
  }

  private timestampSlug(): string {
    return this.now().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  }
}

export class ClaudeSettingsConsentStore {
  private readonly filePath: string;
  private readonly now: () => Date;

  public constructor(options: { storageDir: string; now?: () => Date }) {
    this.filePath = path.join(options.storageDir, "claude-settings-consent.v1.json");
    this.now = options.now ?? (() => new Date());
  }

  public async get(workspaceId: WorkspaceId): Promise<ClaudeSettingsConsentRecord | null> {
    const state = await this.readState();
    return state.workspaces[workspaceId] ?? null;
  }

  public async setDontAskAgain(
    workspaceId: WorkspaceId,
    dontAskAgain: boolean,
  ): Promise<ClaudeSettingsConsentRecord> {
    const state = await this.readState();
    const record: ClaudeSettingsConsentRecord = {
      workspaceId,
      dontAskAgain,
      updatedAt: this.now().toISOString(),
    };
    state.workspaces[workspaceId] = record;
    await writeJson(this.filePath, state);
    return record;
  }

  private async readState(): Promise<{
    version: typeof SETTINGS_VERSION;
    workspaces: Record<string, ClaudeSettingsConsentRecord>;
  }> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (isJsonObject(raw) && raw.version === SETTINGS_VERSION && isJsonObject(raw.workspaces)) {
        return {
          version: SETTINGS_VERSION,
          workspaces: raw.workspaces as Record<string, ClaudeSettingsConsentRecord>,
        };
      }
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") {
        throw error;
      }
    }

    return { version: SETTINGS_VERSION, workspaces: {} };
  }
}

export function buildHookCommands(options: {
  sidecarBin: string;
  dataDir: string;
  workspaceId: WorkspaceId;
}): Record<ClaudeHookEventName, string> {
  const socketPath = path.join(options.dataDir, "sock", `${options.workspaceId}.sock`);
  const baseCommand = `${shellQuote(options.sidecarBin)} hook --socket=${shellQuote(socketPath)} --workspace-id=${shellQuote(options.workspaceId)}`;
  return {
    PreToolUse: `${baseCommand} --event=PreToolUse`,
    PostToolUse: `${baseCommand} --event=PostToolUse`,
    Notification: `${baseCommand} --event=Notification`,
    Stop: `${baseCommand} --event=Stop`,
    StopFailure: `${baseCommand} --event=StopFailure`,
  };
}

function workspaceClaudePaths(workspacePath: string): {
  claudeDir: string;
  settingsPath: string;
  gitignorePath: string;
} {
  const workspaceRoot = path.resolve(workspacePath);
  const claudeDir = path.join(workspaceRoot, ".claude");
  return {
    claudeDir,
    settingsPath: path.join(workspaceRoot, CLAUDE_SETTINGS_RELATIVE_PATH),
    gitignorePath: path.join(workspaceRoot, ".gitignore"),
  };
}

async function readSettings(filePath: string): Promise<{ exists: boolean; value: ClaudeSettingsFile }> {
  const raw = await readTextIfExists(filePath);
  if (raw === null) {
    return { exists: false, value: {} };
  }
  const parsed = JSON.parse(raw) as unknown;
  return { exists: true, value: isJsonObject(parsed) ? parsed : {} };
}

function mergeNexusHooks(
  settings: ClaudeSettingsFile,
  commands: Record<ClaudeHookEventName, string>,
): ClaudeSettingsFile {
  const nextSettings: ClaudeSettingsFile = { ...settings };
  const hooks = cloneHooks(settings.hooks);

  for (const eventName of HOOK_EVENTS) {
    const withoutNexus = (hooks[eventName] ?? []).map(removeNexusHookCommands).filter(hasHookCommands);
    withoutNexus.push(createNexusHookMatcher(eventName, commands[eventName]));
    hooks[eventName] = withoutNexus;
  }

  nextSettings.hooks = hooks;
  return nextSettings;
}

function removeNexusHooks(settings: ClaudeSettingsFile): ClaudeSettingsFile {
  const nextSettings: ClaudeSettingsFile = { ...settings };
  const hooks = cloneHooks(settings.hooks);
  for (const [eventName, matchers] of Object.entries(hooks)) {
    hooks[eventName] = matchers.map(removeNexusHookCommands).filter(hasHookCommands);
  }
  nextSettings.hooks = hooks;
  return nextSettings;
}

function cloneHooks(hooks: unknown): Record<string, ClaudeHookMatcher[]> {
  if (!isJsonObject(hooks)) {
    return {};
  }

  const result: Record<string, ClaudeHookMatcher[]> = {};
  for (const [eventName, rawMatchers] of Object.entries(hooks)) {
    if (!Array.isArray(rawMatchers)) {
      continue;
    }
    result[eventName] = rawMatchers.filter(isJsonObject).map((matcher) => ({
      ...matcher,
      hooks: Array.isArray(matcher.hooks)
        ? matcher.hooks.filter(isJsonObject).map((hook) => ({ ...hook }))
        : [],
    }));
  }
  return result;
}

function createNexusHookMatcher(
  eventName: ClaudeHookEventName,
  command: string,
): ClaudeHookMatcher {
  const hook: ClaudeHookCommand = {
    type: "command",
    command,
    timeout: 5,
    source: NEXUS_SOURCE,
  };

  const matcher: ClaudeHookMatcher = {
    hooks: [hook],
    source: NEXUS_SOURCE,
  };
  if (eventName === "PreToolUse" || eventName === "PostToolUse") {
    matcher.matcher = "*";
  }
  return matcher;
}

function removeNexusHookCommands(matcher: ClaudeHookMatcher): ClaudeHookMatcher {
  return {
    ...matcher,
    hooks: matcher.hooks.filter((hook) => hook.source !== NEXUS_SOURCE),
  };
}

function hasHookCommands(matcher: ClaudeHookMatcher): boolean {
  return matcher.hooks.length > 0;
}

function countNexusHooks(settings: ClaudeSettingsFile): number {
  let count = 0;
  const hooks = cloneHooks(settings.hooks);
  for (const matchers of Object.values(hooks)) {
    for (const matcher of matchers) {
      count += matcher.hooks.filter((hook) => hook.source === NEXUS_SOURCE).length;
    }
  }
  return count;
}

async function ensureGitignoreEntry(gitignorePath: string): Promise<void> {
  const current = await readTextIfExists(gitignorePath);
  if (gitignoreIncludesSettings(current ?? "")) {
    return;
  }

  const prefix = current && !current.endsWith("\n") ? `${current}\n` : current ?? "";
  await writeFile(gitignorePath, `${prefix}${CLAUDE_SETTINGS_GITIGNORE_ENTRY}\n`, "utf8");
}

function gitignoreIncludesSettings(content: string): boolean {
  return content
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .includes(CLAUDE_SETTINGS_GITIGNORE_ENTRY);
}

async function createBackupOnce(
  settingsPath: string,
  claudeDir: string,
  timestampSlug: string,
): Promise<void> {
  const backupPrefix = path.join(claudeDir, "settings.local.json.nexus-backup-");
  const existingBackups = await readdir(claudeDir).catch((error: unknown) => {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return [] as string[];
    }
    throw error;
  });
  if (existingBackups.some((entry) => path.join(claudeDir, entry).startsWith(backupPrefix))) {
    return;
  }
  await copyFile(settingsPath, `${backupPrefix}${timestampSlug}`);
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export const CLAUDE_SETTINGS_MANAGER_TEST_ONLY = {
  CLAUDE_SETTINGS_GITIGNORE_ENTRY,
  NEXUS_SOURCE,
};
