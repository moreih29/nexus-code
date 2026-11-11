import { beforeEach, describe, expect, test } from "bun:test";
import {
  ASK_TIMEOUT_MS,
  type AskResult,
  type AskRunner,
  askNotificationService,
  DesktopNotifications,
  OFF_FOR_MS,
  runAsker,
  type ServiceAnswer,
  SLOW_SHOW_MS,
} from "../../../../../src/main/infra/platform/desktop-notifications";
import { mainInfoMock, mainWarnMock } from "../../../../log-test-spies";

beforeEach(() => {
  mainInfoMock.mockClear();
  mainWarnMock.mockClear();
});

const warned = () => mainWarnMock.mock.calls.map(([msg]) => msg);

/** A gate over D-Bus whose service answers when the test says, and whose clock it moves. */
function gate(overDbus = true) {
  let clock = 0;
  const asked: Array<(answer: ServiceAnswer, detail?: string) => void> = [];
  const notifications = new DesktopNotifications({
    overDbus,
    ask: () =>
      new Promise((resolve) => {
        asked.push((answer, detail) => resolve({ answer, detail }));
      }),
    now: () => clock,
  });
  let shown = 0;
  const show = (takes = 0) =>
    notifications.show(() => {
      shown++;
      clock += takes;
    });
  return {
    notifications,
    show,
    shown: () => shown,
    asked,
    /** Answers the last question, and lets the gate take the answer. */
    answer: async (answer: ServiceAnswer, detail?: string) => {
      asked.at(-1)?.(answer, detail);
      await Promise.resolve();
      await Promise.resolve();
    },
    pass: (ms: number) => {
      clock += ms;
    },
  };
}

describe("DesktopNotifications", () => {
  test("off D-Bus (macOS, Windows) a notification goes out at once, unasked", () => {
    const g = gate(false);
    g.notifications.start();
    expect(g.show(SLOW_SHOW_MS * 10)).toBe(true);
    expect(g.show()).toBe(true);
    expect(g.shown()).toBe(2);
    expect(g.asked).toHaveLength(0);
  });

  test("notifications wait for the service's answer, and go out once it answers", async () => {
    const g = gate();
    g.notifications.start();
    expect(g.asked).toHaveLength(1);
    expect(g.show()).toBe(false);
    await g.answer("answers");
    expect(g.show()).toBe(true);
    expect(g.shown()).toBe(1);
    expect(warned()).toEqual([]);
  });

  test("a silent service turns them off, and is asked again after a while", async () => {
    const g = gate();
    g.notifications.start();
    await g.answer("silent", "gdbus: no answer in 5000 ms");
    expect(warned()).toEqual([
      "desktop notifications are off until the notification service answers: " +
        "the notification service did not answer (gdbus: no answer in 5000 ms)",
    ]);

    expect(g.show()).toBe(false);
    g.pass(OFF_FOR_MS - 1);
    expect(g.show()).toBe(false);
    expect(g.asked).toHaveLength(1);

    // The first after the while asks again, and goes no further itself.
    g.pass(1);
    expect(g.show()).toBe(false);
    expect(g.asked).toHaveLength(2);
    await g.answer("silent", "gdbus: no answer in 5000 ms");
    expect(warned()).toHaveLength(1);
    expect(g.show()).toBe(false);

    g.pass(OFF_FOR_MS);
    g.show();
    await g.answer("answers");
    expect(g.show()).toBe(true);
    expect(g.shown()).toBe(1);
    expect(mainInfoMock.mock.calls.map(([msg]) => msg)).toContain(
      "the notification service answers again: desktop notifications are back on",
    );
  });

  test("a notification that holds the app turns the next ones off", async () => {
    const g = gate();
    g.notifications.start();
    await g.answer("answers");
    expect(g.show(SLOW_SHOW_MS)).toBe(true);
    expect(g.show(SLOW_SHOW_MS + 1)).toBe(true);
    expect(warned()).toEqual([
      "desktop notifications are off until the notification service answers: " +
        `a notification held the app for ${SLOW_SHOW_MS + 1} ms`,
    ]);
    expect(g.show()).toBe(false);
    expect(g.shown()).toBe(2);
  });

  test("with nothing to ask with, notifications go out, still timed", async () => {
    const g = gate();
    g.notifications.start();
    await g.answer("unknown");
    expect(g.show()).toBe(true);
    expect(g.show(SLOW_SHOW_MS + 1)).toBe(true);
    expect(g.show()).toBe(false);

    // Nothing can tell the service answers again: they stay off, not holding the app every while.
    g.pass(OFF_FOR_MS);
    expect(g.show()).toBe(false);
    await g.answer("unknown");
    expect(g.show()).toBe(false);
    expect(g.shown()).toBe(2);
    expect(warned()).toHaveLength(1);
  });

  test("a question that throws counts as nothing to ask with, not as asking for ever", async () => {
    let clock = 0;
    const notifications = new DesktopNotifications({
      overDbus: true,
      ask: () => Promise.reject(new Error("spawn failed")),
      now: () => clock++,
    });
    notifications.start();
    await Promise.resolve();
    await Promise.resolve();
    let shown = 0;
    expect(notifications.show(() => shown++)).toBe(true);
    expect(shown).toBe(1);
  });

  test("never asked (start not called), notifications go out", () => {
    const g = gate();
    expect(g.show()).toBe(true);
    expect(g.asked).toHaveLength(0);
  });
});

describe("askNotificationService", () => {
  /** A runner that ends each command as `ends` says, and records what it ran. */
  function runner(ends: Record<string, AskResult>) {
    const ran: string[] = [];
    const run: AskRunner = async (file, args, timeoutMs) => {
      ran.push(`${file} ${args.join(" ")}`);
      expect(timeoutMs).toBe(ASK_TIMEOUT_MS);
      return ends[file] ?? { ended: "missing" };
    };
    return { run, ran };
  }

  test("asks the session bus's notification service with gdbus", async () => {
    const { run, ran } = runner({ gdbus: { ended: "ok" } });
    expect(await askNotificationService(run)).toEqual({ answer: "answers" });
    expect(ran).toEqual([
      "gdbus call --session --dest org.freedesktop.Notifications --object-path " +
        "/org/freedesktop/Notifications --method org.freedesktop.Notifications.GetServerInformation",
    ]);
  });

  test("a failed question is a silent service, without asking again with dbus-send", async () => {
    const { run, ran } = runner({
      gdbus: { ended: "failed", detail: "gdbus: no answer in 5000 ms" },
      "dbus-send": { ended: "ok" },
    });
    expect(await askNotificationService(run)).toEqual({
      answer: "silent",
      detail: "gdbus: no answer in 5000 ms",
    });
    expect(ran).toHaveLength(1);
  });

  test("dbus-send asks when gdbus is not there; neither there is unknown", async () => {
    const withSend = runner({ "dbus-send": { ended: "ok" } });
    expect(await askNotificationService(withSend.run)).toEqual({ answer: "answers" });
    expect(withSend.ran[1]).toStartWith("dbus-send --session --print-reply");

    expect(await askNotificationService(runner({}).run)).toEqual({ answer: "unknown" });
  });
});

describe("runAsker", () => {
  const node = process.execPath;

  test("tells a command that ran, failed, or is not there", async () => {
    expect(await runAsker(node, ["-e", ""], 10_000)).toEqual({ ended: "ok" });
    const failed = await runAsker(node, ["-e", "console.error('no bus'); process.exit(1)"], 10_000);
    expect(failed).toEqual({ ended: "failed", detail: `${node}: no bus` });
    expect(await runAsker("nexus-no-such-command", [], 10_000)).toEqual({ ended: "missing" });
  });

  test("kills a command that does not end in time", async () => {
    const started = Date.now();
    const result = await runAsker(node, ["-e", "setTimeout(() => {}, 30000)"], 300);
    expect(result).toEqual({ ended: "failed", detail: `${node}: no answer in 300 ms` });
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
