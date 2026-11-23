import { execFile } from "node:child_process";
import { createLogger } from "../../../shared/log/main";

const logger = createLogger("notifications");

export const ASK_TIMEOUT_MS = 5_000;
export const OFF_FOR_MS = 5 * 60_000;
export const SLOW_SHOW_MS = 1_000;

export type ServiceAnswer = "answers" | "silent" | "unknown";

export interface AskResult {
  ended: "ok" | "failed" | "missing";
  detail?: string;
}

export type AskRunner = (file: string, args: string[], timeoutMs: number) => Promise<AskResult>;

const SERVICE = "org.freedesktop.Notifications";
const SERVICE_PATH = "/org/freedesktop/Notifications";
const ASK_METHOD = `${SERVICE}.GetServerInformation`;

const ASKERS: ReadonlyArray<readonly [string, string[]]> = [
  [
    "gdbus",
    ["call", "--session", "--dest", SERVICE, "--object-path", SERVICE_PATH, "--method", ASK_METHOD],
  ],
  ["dbus-send", ["--session", "--print-reply", `--dest=${SERVICE}`, SERVICE_PATH, ASK_METHOD]],
];

export const runAsker: AskRunner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, killSignal: "SIGKILL", windowsHide: true },
      (error, _stdout, stderr) => {
        if (!error) return resolve({ ended: "ok" });
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return resolve({ ended: "missing" });
        const said = String(stderr).trim().split(/\r?\n/)[0];
        const detail = error.killed ? `no answer in ${timeoutMs} ms` : said || error.message;
        resolve({ ended: "failed", detail: `${file}: ${detail}` });
      },
    );
  });

export async function askNotificationService(
  run: AskRunner = runAsker,
): Promise<{ answer: ServiceAnswer; detail?: string }> {
  for (const [file, args] of ASKERS) {
    const result = await run(file, [...args], ASK_TIMEOUT_MS);
    if (result.ended === "missing") continue;
    return result.ended === "ok"
      ? { answer: "answers" }
      : { answer: "silent", detail: result.detail };
  }
  return { answer: "unknown" };
}

export interface DesktopNotificationsDeps {
  overDbus: boolean;
  ask: () => Promise<{ answer: ServiceAnswer; detail?: string }>;
  now: () => number;
}

export class DesktopNotifications {
  private state: "on" | "asking" | "off" = "on";
  private offUntil = 0;

  constructor(private readonly deps: DesktopNotificationsDeps) {}

  start(): void {
    if (this.deps.overDbus && this.state === "on") void this.ask();
  }

  show(show: () => void): boolean {
    if (!this.deps.overDbus) {
      show();
      return true;
    }
    if (this.state === "asking") return false;
    if (this.state === "off") {
      if (this.deps.now() >= this.offUntil) void this.ask();
      return false;
    }
    const started = this.deps.now();
    show();
    const took = this.deps.now() - started;
    if (took > SLOW_SHOW_MS) this.turnOff(`a notification held the app for ${took} ms`);
    return true;
  }

  private async ask(): Promise<void> {
    const wasOff = this.state === "off";
    this.state = "asking";
    const { answer, detail } = await this.deps
      .ask()
      .catch((error: Error) => ({ answer: "unknown" as const, detail: error.message }));
    if (answer === "silent") {
      this.turnOff(`the notification service did not answer (${detail ?? "no detail"})`, wasOff);
      return;
    }
    if (answer === "unknown" && wasOff) {
      this.turnOff("", true);
      return;
    }
    this.state = "on";
    if (answer === "unknown") {
      logger.info(
        "neither gdbus nor dbus-send is here to ask the notification service with; " +
          "notifications go out unasked",
      );
    } else if (wasOff) {
      logger.info("the notification service answers again: desktop notifications are back on");
    }
  }

  private turnOff(reason: string, wasOff = false): void {
    this.state = "off";
    this.offUntil = this.deps.now() + OFF_FOR_MS;
    if (!wasOff) {
      logger.warn(
        `desktop notifications are off until the notification service answers: ${reason}`,
      );
    }
  }
}

const desktopNotifications = new DesktopNotifications({
  overDbus: process.platform === "linux",
  ask: () => askNotificationService(),
  now: () => Date.now(),
});

export function startDesktopNotifications(): void {
  desktopNotifications.start();
}

export function showDesktopNotification(show: () => void): boolean {
  return desktopNotifications.show(show);
}
