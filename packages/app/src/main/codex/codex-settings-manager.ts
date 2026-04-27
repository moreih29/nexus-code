import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";

const CODEX_DIR_NAME = ".codex";
const CODEX_HOOKS_FILENAME = "hooks.json";
const CODEX_CONFIG_FILENAME = "config.toml";
const CODEX_HOOKS_RELATIVE_PATH = path.join(CODEX_DIR_NAME, CODEX_HOOKS_FILENAME);
const CODEX_CONFIG_RELATIVE_PATH = path.join(CODEX_DIR_NAME, CODEX_CONFIG_FILENAME);
const CODEX_HOOKS_GITIGNORE_ENTRY = ".codex/hooks.json";
const CODEX_CONFIG_GITIGNORE_ENTRY = ".codex/config.toml";
const CODEX_HOOK_STATUS_MESSAGE = "Nexus Code observer";
const CODEX_CONFIG_MARKER = "# nexus-code";
const SETTINGS_VERSION = 1;

export type CodexHookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PermissionRequest"
  | "PostToolUse"
  | "Stop";

export interface CodexSettingsManagerOptions {
  sidecarBin: string;
  dataDir: string;
  now?: () => Date;
}

export interface CodexWorkspaceRegistration {
  workspaceId: WorkspaceId;
  workspacePath: string;
}

export interface CodexSettingsDetection {
  hooksPath: string;
  hooksExists: boolean;
  nexusHookCount: number;
  configPath: string;
  configExists: boolean;
  configEnablesHooks: boolean;
  gitignorePath: string;
  gitignoreIncludesHooks: boolean;
  gitignoreIncludesConfig: boolean;
}

export interface CodexSettingsConsentRecord {
  workspaceId: WorkspaceId;
  dontAskAgain: boolean;
  updatedAt: string;
}

type JsonObject = Record<string, unknown>;

type CodexHookCommand = {
  type: "command";
  command: string;
  timeout: number;
  statusMessage: typeof CODEX_HOOK_STATUS_MESSAGE;
};

type CodexHookMatcher = {
  matcher?: string;
  hooks: Array<Record<string, unknown>>;
};

interface CodexHooksFile extends JsonObject {
  hooks?: Record<string, CodexHookMatcher[]>;
}

const HOOK_EVENTS: CodexHookEventName[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
];

const CODEX_GITIGNORE_ENTRIES = [
  CODEX_HOOKS_GITIGNORE_ENTRY,
  CODEX_CONFIG_GITIGNORE_ENTRY,
] as const;

export class CodexSettingsManager {
  private readonly sidecarBin: string;
  private readonly dataDir: string;
  private readonly now: () => Date;

  public constructor(options: CodexSettingsManagerOptions) {
    this.sidecarBin = options.sidecarBin;
    this.dataDir = options.dataDir;
    this.now = options.now ?? (() => new Date());
  }

  public async detectExisting(
    registration: CodexWorkspaceRegistration,
  ): Promise<CodexSettingsDetection> {
    const paths = workspaceCodexPaths(registration.workspacePath);
    const hooks = await readHooks(paths.hooksPath);
    const config = await readTextIfExists(paths.configPath);
    const gitignore = await readTextIfExists(paths.gitignorePath);

    return {
      hooksPath: paths.hooksPath,
      hooksExists: hooks.exists,
      nexusHookCount: hooks.exists ? countNexusHooks(hooks.value) : 0,
      configPath: paths.configPath,
      configExists: config !== null,
      configEnablesHooks: configEnablesCodexHooks(config ?? ""),
      gitignorePath: paths.gitignorePath,
      gitignoreIncludesHooks: gitignoreIncludesEntry(gitignore ?? "", CODEX_HOOKS_GITIGNORE_ENTRY),
      gitignoreIncludesConfig: gitignoreIncludesEntry(gitignore ?? "", CODEX_CONFIG_GITIGNORE_ENTRY),
    };
  }

  public async register(registration: CodexWorkspaceRegistration): Promise<CodexSettingsDetection> {
    const paths = workspaceCodexPaths(registration.workspacePath);
    await mkdir(paths.codexDir, { recursive: true });

    const hooks = await readHooks(paths.hooksPath);
    if (hooks.exists) {
      await createBackupOnce(paths.hooksPath, paths.codexDir, `${CODEX_HOOKS_FILENAME}.nexus-backup-`, this.timestampSlug());
    }

    const nextHooks = mergeNexusHooks(
      hooks.exists ? hooks.value : {},
      buildCodexHookCommands({
        sidecarBin: this.sidecarBin,
        dataDir: this.dataDir,
        workspaceId: registration.workspaceId,
      }),
    );
    await writeJson(paths.hooksPath, nextHooks);

    const config = await readTextIfExists(paths.configPath);
    if (config !== null) {
      await createBackupOnce(paths.configPath, paths.codexDir, `${CODEX_CONFIG_FILENAME}.nexus-backup-`, this.timestampSlug());
    }
    await writeFile(paths.configPath, ensureCodexHooksEnabled(config ?? ""), "utf8");

    await ensureGitignoreEntries(paths.gitignorePath, CODEX_GITIGNORE_ENTRIES);

    return this.detectExisting(registration);
  }

  public async unregister(registration: CodexWorkspaceRegistration): Promise<CodexSettingsDetection> {
    const paths = workspaceCodexPaths(registration.workspacePath);
    const hooks = await readHooks(paths.hooksPath);
    if (hooks.exists) {
      await writeJson(paths.hooksPath, removeNexusHooks(hooks.value));
    }

    const config = await readTextIfExists(paths.configPath);
    if (config !== null) {
      await writeFile(paths.configPath, removeNexusCodexHooksConfigMarker(config), "utf8");
    }

    return this.detectExisting(registration);
  }

  private timestampSlug(): string {
    return this.now().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  }
}

export class CodexSettingsConsentStore {
  private readonly filePath: string;
  private readonly now: () => Date;

  public constructor(options: { storageDir: string; now?: () => Date }) {
    this.filePath = path.join(options.storageDir, "codex-settings-consent.v1.json");
    this.now = options.now ?? (() => new Date());
  }

  public async get(workspaceId: WorkspaceId): Promise<CodexSettingsConsentRecord | null> {
    const state = await this.readState();
    return state.workspaces[workspaceId] ?? null;
  }

  public async setDontAskAgain(
    workspaceId: WorkspaceId,
    dontAskAgain: boolean,
  ): Promise<CodexSettingsConsentRecord> {
    const state = await this.readState();
    const record: CodexSettingsConsentRecord = {
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
    workspaces: Record<string, CodexSettingsConsentRecord>;
  }> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (isJsonObject(raw) && raw.version === SETTINGS_VERSION && isJsonObject(raw.workspaces)) {
        return {
          version: SETTINGS_VERSION,
          workspaces: raw.workspaces as Record<string, CodexSettingsConsentRecord>,
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

export function buildCodexHookCommands(options: {
  sidecarBin: string;
  dataDir: string;
  workspaceId: WorkspaceId;
}): Record<CodexHookEventName, string> {
  const socketPath = path.join(options.dataDir, "sock", `${options.workspaceId}.sock`);
  const baseCommand = `${shellQuote(options.sidecarBin)} hook --socket=${shellQuote(socketPath)} --workspace-id=${shellQuote(options.workspaceId)} --adapter=codex`;
  return {
    SessionStart: `${baseCommand} --event=SessionStart`,
    UserPromptSubmit: `${baseCommand} --event=UserPromptSubmit`,
    PreToolUse: `${baseCommand} --event=PreToolUse`,
    PermissionRequest: `${baseCommand} --event=PermissionRequest`,
    PostToolUse: `${baseCommand} --event=PostToolUse`,
    Stop: `${baseCommand} --event=Stop`,
  };
}

function workspaceCodexPaths(workspacePath: string): {
  codexDir: string;
  hooksPath: string;
  configPath: string;
  gitignorePath: string;
} {
  const workspaceRoot = path.resolve(workspacePath);
  const codexDir = path.join(workspaceRoot, CODEX_DIR_NAME);
  return {
    codexDir,
    hooksPath: path.join(workspaceRoot, CODEX_HOOKS_RELATIVE_PATH),
    configPath: path.join(workspaceRoot, CODEX_CONFIG_RELATIVE_PATH),
    gitignorePath: path.join(workspaceRoot, ".gitignore"),
  };
}

async function readHooks(filePath: string): Promise<{ exists: boolean; value: CodexHooksFile }> {
  const raw = await readTextIfExists(filePath);
  if (raw === null) {
    return { exists: false, value: {} };
  }
  const parsed = JSON.parse(raw) as unknown;
  return { exists: true, value: isJsonObject(parsed) ? parsed : {} };
}

function mergeNexusHooks(
  hooksFile: CodexHooksFile,
  commands: Record<CodexHookEventName, string>,
): CodexHooksFile {
  const nextHooksFile: CodexHooksFile = { ...hooksFile };
  const hooks = cloneHooks(hooksFile.hooks);

  for (const eventName of HOOK_EVENTS) {
    const withoutNexus = (hooks[eventName] ?? []).map(removeNexusHookCommands).filter(hasHookCommands);
    withoutNexus.push(createNexusHookMatcher(eventName, commands[eventName]));
    hooks[eventName] = withoutNexus;
  }

  nextHooksFile.hooks = hooks;
  return nextHooksFile;
}

function removeNexusHooks(hooksFile: CodexHooksFile): CodexHooksFile {
  const nextHooksFile: CodexHooksFile = { ...hooksFile };
  const hooks = cloneHooks(hooksFile.hooks);
  for (const [eventName, matchers] of Object.entries(hooks)) {
    hooks[eventName] = matchers.map(removeNexusHookCommands).filter(hasHookCommands);
  }
  nextHooksFile.hooks = hooks;
  return nextHooksFile;
}

function cloneHooks(hooks: unknown): Record<string, CodexHookMatcher[]> {
  if (!isJsonObject(hooks)) {
    return {};
  }

  const result: Record<string, CodexHookMatcher[]> = {};
  for (const [eventName, rawMatchers] of Object.entries(hooks)) {
    if (!Array.isArray(rawMatchers)) {
      continue;
    }
    result[eventName] = rawMatchers.filter(isJsonObject).map((matcher) => ({
      ...(typeof matcher.matcher === "string" ? { matcher: matcher.matcher } : {}),
      hooks: Array.isArray(matcher.hooks)
        ? matcher.hooks.filter(isJsonObject).map((hook) => ({ ...hook }))
        : [],
    }));
  }
  return result;
}

function createNexusHookMatcher(
  eventName: CodexHookEventName,
  command: string,
): CodexHookMatcher {
  const hook: CodexHookCommand = {
    type: "command",
    command,
    timeout: 5,
    statusMessage: CODEX_HOOK_STATUS_MESSAGE,
  };

  const matcher: CodexHookMatcher = {
    hooks: [hook],
  };
  if (eventName === "SessionStart") {
    matcher.matcher = "*";
  }
  if (eventName === "PreToolUse" || eventName === "PermissionRequest" || eventName === "PostToolUse") {
    matcher.matcher = "*";
  }
  return matcher;
}

function removeNexusHookCommands(matcher: CodexHookMatcher): CodexHookMatcher {
  return {
    ...matcher,
    hooks: matcher.hooks.filter((hook) => !isNexusCodexHookCommand(hook)),
  };
}

function hasHookCommands(matcher: CodexHookMatcher): boolean {
  return matcher.hooks.length > 0;
}

function countNexusHooks(hooksFile: CodexHooksFile): number {
  let count = 0;
  const hooks = cloneHooks(hooksFile.hooks);
  for (const matchers of Object.values(hooks)) {
    for (const matcher of matchers) {
      count += matcher.hooks.filter(isNexusCodexHookCommand).length;
    }
  }
  return count;
}

function isNexusCodexHookCommand(hook: Record<string, unknown>): boolean {
  const command = typeof hook.command === "string" ? hook.command : "";
  return command.includes(" hook ") && command.includes("--adapter=codex");
}

function ensureCodexHooksEnabled(content: string): string {
  const lines = splitPreservingEmpty(content);
  const codexHooksLineIndex = lines.findIndex((line) => /^\s*codex_hooks\s*=/.test(line));
  if (codexHooksLineIndex >= 0) {
    const nextLines = [...lines];
    nextLines[codexHooksLineIndex] = `codex_hooks = true ${CODEX_CONFIG_MARKER}`;
    return ensureTrailingNewline(nextLines.join("\n"));
  }

  const featuresLineIndex = lines.findIndex((line) => /^\s*\[features\]\s*(?:#.*)?$/.test(line));
  if (featuresLineIndex >= 0) {
    const nextLines = [...lines];
    nextLines.splice(featuresLineIndex + 1, 0, `codex_hooks = true ${CODEX_CONFIG_MARKER}`);
    return ensureTrailingNewline(nextLines.join("\n"));
  }

  const prefix = content.trim().length > 0 ? `${content.replace(/\s*$/, "\n\n")}` : "";
  return `${prefix}[features]\ncodex_hooks = true ${CODEX_CONFIG_MARKER}\n`;
}

function removeNexusCodexHooksConfigMarker(content: string): string {
  const lines = splitPreservingEmpty(content);
  const nextLines = lines.filter((line) => {
    return !/^\s*codex_hooks\s*=\s*true\s*#\s*nexus-code\s*$/.test(line);
  });
  return ensureTrailingNewline(nextLines.join("\n"));
}

function configEnablesCodexHooks(content: string): boolean {
  return splitPreservingEmpty(content).some((line) => {
    const withoutComment = line.split("#", 1)[0] ?? "";
    return /^\s*codex_hooks\s*=\s*true\s*$/i.test(withoutComment.trim());
  });
}

function splitPreservingEmpty(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized === "") {
    return [];
  }
  return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

async function ensureGitignoreEntries(
  gitignorePath: string,
  entries: readonly string[],
): Promise<void> {
  const current = await readTextIfExists(gitignorePath);
  const missingEntries = entries.filter((entry) => !gitignoreIncludesEntry(current ?? "", entry));
  if (missingEntries.length === 0) {
    return;
  }

  const prefix = current && !current.endsWith("\n") ? `${current}\n` : current ?? "";
  await writeFile(gitignorePath, `${prefix}${missingEntries.join("\n")}\n`, "utf8");
}

function gitignoreIncludesEntry(content: string, entry: string): boolean {
  return content
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .includes(entry);
}

async function createBackupOnce(
  filePath: string,
  codexDir: string,
  backupNamePrefix: string,
  timestampSlug: string,
): Promise<void> {
  const existingBackups = await readdir(codexDir).catch((error: unknown) => {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return [] as string[];
    }
    throw error;
  });
  if (existingBackups.some((entry) => entry.startsWith(backupNamePrefix))) {
    return;
  }
  await copyFile(filePath, path.join(codexDir, `${backupNamePrefix}${timestampSlug}`));
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

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
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

export const CODEX_SETTINGS_MANAGER_TEST_ONLY = {
  CODEX_HOOKS_GITIGNORE_ENTRY,
  CODEX_CONFIG_GITIGNORE_ENTRY,
  CODEX_HOOK_STATUS_MESSAGE,
  CODEX_CONFIG_MARKER,
};
