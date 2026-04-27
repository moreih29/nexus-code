import { spawn } from "node:child_process";

const DEFAULT_CAPTURE_TIMEOUT_MS = 5_000;
const DEFAULT_SHELL_PATH = "/bin/zsh";
const DEFAULT_SHELL_ARGS = ["-l", "-i"] as const;
const CAPTURE_ENV_COMMAND = "env";
const CAPTURE_ENV_ARGS = [...DEFAULT_SHELL_ARGS, "-c", CAPTURE_ENV_COMMAND] as const;
const DEFAULT_TERM = "xterm-256color";
const DEFAULT_COLORTERM = "truecolor";
const DEFAULT_LOCALE = "en_US.UTF-8";

export interface ShellEnvironmentCaptureRequest {
  shellPath: string;
  shellArgs: readonly string[];
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}

export type ShellEnvironmentCaptureResult =
  | {
      status: "ok";
      stdout: string;
    }
  | {
      status: "timeout";
    }
  | {
      status: "error";
      error: unknown;
    };

export type ShellEnvironmentCapture = (
  request: ShellEnvironmentCaptureRequest,
) => Promise<ShellEnvironmentCaptureResult>;

export type ShellEnvironmentDevLogger = (message: string, error?: unknown) => void;

export interface ShellEnvironmentResolverOptions {
  processEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  captureEnvironment?: ShellEnvironmentCapture;
  onDevLog?: ShellEnvironmentDevLogger;
}

export class ShellEnvironmentResolver {
  private readonly processEnv: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly captureEnvironment: ShellEnvironmentCapture;
  private readonly onDevLog: ShellEnvironmentDevLogger;

  private cachedBaseEnv: Record<string, string> | null = null;
  private inFlightBaseEnv: Promise<Record<string, string>> | null = null;

  public constructor(options: ShellEnvironmentResolverOptions = {}) {
    this.processEnv = options.processEnv ?? process.env;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
    this.captureEnvironment = options.captureEnvironment ?? captureShellEnvironment;
    this.onDevLog = options.onDevLog ?? (() => undefined);
  }

  public async getBaseEnv(): Promise<Record<string, string>> {
    if (this.cachedBaseEnv) {
      return { ...this.cachedBaseEnv };
    }

    if (!this.inFlightBaseEnv) {
      this.inFlightBaseEnv = this.resolveAndCacheBaseEnv();
    }

    const baseEnv = await this.inFlightBaseEnv;
    return { ...baseEnv };
  }

  public getDefaultShell(): string {
    const shellFromCache = this.cachedBaseEnv?.SHELL;
    return resolveDefaultShell(shellFromCache ?? this.processEnv.SHELL);
  }

  public getDefaultShellArgs(): string[] {
    return [...DEFAULT_SHELL_ARGS];
  }

  private async resolveAndCacheBaseEnv(): Promise<Record<string, string>> {
    try {
      const resolvedBaseEnv = await this.resolveBaseEnv();
      this.cachedBaseEnv = resolvedBaseEnv;
      return resolvedBaseEnv;
    } finally {
      this.inFlightBaseEnv = null;
    }
  }

  private async resolveBaseEnv(): Promise<Record<string, string>> {
    const sanitizedProcessEnv = sanitizeEnvironmentObject(this.processEnv);

    const captureResult = await this.captureEnvironment({
      shellPath: this.getDefaultShell(),
      shellArgs: CAPTURE_ENV_ARGS,
      timeoutMs: this.timeoutMs,
      env: this.processEnv,
    });

    if (captureResult.status === "ok") {
      const capturedShellEnv = parseShellEnvironmentOutput(captureResult.stdout);
      if (Object.keys(capturedShellEnv).length > 0) {
        return applyEnvironmentDefaults({
          ...sanitizedProcessEnv,
          ...capturedShellEnv,
        });
      }

      this.onDevLog(
        "ShellEnvironmentResolver: shell capture returned no parseable entries, falling back to process.env.",
      );
      return applyEnvironmentDefaults(sanitizedProcessEnv);
    }

    if (captureResult.status === "timeout") {
      this.onDevLog(
        `ShellEnvironmentResolver: shell capture timed out after ${this.timeoutMs}ms, falling back to process.env.`,
      );
      return applyEnvironmentDefaults(sanitizedProcessEnv);
    }

    this.onDevLog(
      "ShellEnvironmentResolver: shell capture failed, falling back to process.env.",
      captureResult.error,
    );
    return applyEnvironmentDefaults(sanitizedProcessEnv);
  }
}

export function parseShellEnvironmentOutput(output: string): Record<string, string> {
  const parsedEnvironment: Record<string, string> = {};

  for (const line of output.split(/\r?\n/u)) {
    if (line.length === 0) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex);
    if (!isValidEnvironmentKey(key)) {
      continue;
    }

    const value = line.slice(separatorIndex + 1);
    parsedEnvironment[key] = value;
  }

  return parsedEnvironment;
}

function sanitizeEnvironmentObject(environment: NodeJS.ProcessEnv): Record<string, string> {
  const sanitizedEnvironment: Record<string, string> = {};

  for (const [key, value] of Object.entries(environment)) {
    if (!isValidEnvironmentKey(key) || typeof value !== "string") {
      continue;
    }

    sanitizedEnvironment[key] = value;
  }

  return sanitizedEnvironment;
}

function applyEnvironmentDefaults(environment: Record<string, string>): Record<string, string> {
  const withDefaults: Record<string, string> = {
    ...environment,
    TERM: DEFAULT_TERM,
    COLORTERM: DEFAULT_COLORTERM,
  };

  if (withDefaults.LANG === undefined) {
    withDefaults.LANG = DEFAULT_LOCALE;
  }

  if (withDefaults.LC_ALL === undefined) {
    withDefaults.LC_ALL = DEFAULT_LOCALE;
  }

  return withDefaults;
}

function resolveDefaultShell(shellPath: string | undefined): string {
  const normalizedShell = shellPath?.trim();
  if (!normalizedShell) {
    return DEFAULT_SHELL_PATH;
  }

  return normalizedShell;
}

function isValidEnvironmentKey(key: string): boolean {
  return key.length > 0 && !key.includes("\u0000");
}

async function captureShellEnvironment(
  request: ShellEnvironmentCaptureRequest,
): Promise<ShellEnvironmentCaptureResult> {
  return new Promise((resolve) => {
    let settled = false;
    let capturedStdout = "";

    const childProcess = spawn(request.shellPath, [...request.shellArgs], {
      env: request.env,
      stdio: ["ignore", "pipe", "ignore"],
    });

    const timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      childProcess.kill("SIGKILL");
      resolve({ status: "timeout" });
    }, request.timeoutMs);

    timeoutHandle.unref?.();

    childProcess.stdout?.setEncoding("utf8");
    childProcess.stdout?.on("data", (chunk: string | Buffer) => {
      capturedStdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });

    childProcess.once("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      resolve({ status: "error", error });
    });

    childProcess.once("close", () => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      resolve({
        status: "ok",
        stdout: capturedStdout,
      });
    });
  });
}
