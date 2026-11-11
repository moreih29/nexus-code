/**
 * Desktop notifications that cannot stall the app.
 *
 * On Linux a notification goes to the desktop's notification service over the
 * session D-Bus, in calls Electron makes on the main thread and waits on.
 * When nothing answers on the bus, each call waits out D-Bus's 25 s timeout,
 * and a notification makes several: every window, terminal and chat of the
 * app stops for a minute or more, once for each notification. That happens
 * where the bus the app reaches is not the desktop's (an app started over
 * ssh, or by something that started a bus of its own), or the service hangs.
 *
 * So on Linux a child process asks the service first, at startup and again
 * when it has not answered for a while, and notifications go out only while
 * it answers. A notification that still holds the app (the service stopped
 * answering since) turns them off until it answers again. Elsewhere
 * notifications go out as they come.
 */
import { execFile } from "node:child_process";
import { createLogger } from "../../../shared/log/main";

const logger = createLogger("notifications");

/** How long the notification service has to answer the child's question. */
export const ASK_TIMEOUT_MS = 5_000;
/** How long notifications stay off before the service is asked again. */
export const OFF_FOR_MS = 5 * 60_000;
/** A notification that holds the main thread longer than this turns them off. */
export const SLOW_SHOW_MS = 1_000;

/**
 * What asking the notification service found: it answered, it did not (or
 * the bus could not be reached), or nothing on the machine could ask it.
 */
export type ServiceAnswer = "answers" | "silent" | "unknown";

/** How one asking command ended, and what it said when it failed. */
export interface AskResult {
  ended: "ok" | "failed" | "missing";
  detail?: string;
}

/** Runs a command for at most `timeoutMs` without waiting on it. */
export type AskRunner = (file: string, args: string[], timeoutMs: number) => Promise<AskResult>;

const SERVICE = "org.freedesktop.Notifications";
const SERVICE_PATH = "/org/freedesktop/Notifications";
const ASK_METHOD = `${SERVICE}.GetServerInformation`;

/**
 * The commands that can ask the service for its name, best first: gdbus
 * reaches the bus as libnotify does (both are GLib), dbus-send is for a
 * machine without it.
 */
const ASKERS: ReadonlyArray<readonly [string, string[]]> = [
  [
    "gdbus",
    ["call", "--session", "--dest", SERVICE, "--object-path", SERVICE_PATH, "--method", ASK_METHOD],
  ],
  ["dbus-send", ["--session", "--print-reply", `--dest=${SERVICE}`, SERVICE_PATH, ASK_METHOD]],
];

/** Runs a command in a child process, killed when it outlasts `timeoutMs`. */
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

/**
 * Asks the session bus's notification service for its name, in a child
 * process: the main thread goes on while it waits.
 */
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
  /** Whether notifications go over D-Bus, where they can hold the app: Linux. */
  overDbus: boolean;
  /** Asks the notification service whether it answers. */
  ask: () => Promise<{ answer: ServiceAnswer; detail?: string }>;
  /** Milliseconds, for timing notifications and how long they stay off. */
  now: () => number;
}

/**
 * Whether desktop notifications go out now. On until a question finds the
 * service silent or a notification holds the app; off until the service
 * answers again, asked once OFF_FOR_MS has passed.
 */
export class DesktopNotifications {
  private state: "on" | "asking" | "off" = "on";
  private offUntil = 0;

  constructor(private readonly deps: DesktopNotificationsDeps) {}

  /** Asks the service before any notification needs it: at startup. */
  start(): void {
    if (this.deps.overDbus && this.state === "on") void this.ask();
  }

  /**
   * Runs `show`, which makes and shows a notification, when notifications go
   * out now; answers whether it ran. One that comes while they are off is
   * dropped; the first once OFF_FOR_MS has passed has the service asked
   * again, for the ones after it.
   */
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
    // Off because a notification held the app, with nothing to ask the
    // service with: nothing tells it answers now, so they stay off.
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

/** Asks the notification service, on Linux, before the first notification. */
export function startDesktopNotifications(): void {
  desktopNotifications.start();
}

/**
 * Runs `show`, which makes and shows an Electron Notification, unless that
 * could hold the app; answers whether it ran.
 */
export function showDesktopNotification(show: () => void): boolean {
  return desktopNotifications.show(show);
}
