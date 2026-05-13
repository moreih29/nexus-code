/**
 * Scenario tests for clone stderr progress parsing and throttling.
 */
import { describe, expect, it } from "bun:test";
import {
  GIT_CLONE_PROGRESS_MIN_INTERVAL_MS,
  GitStderrProgressReceiver,
  parseCloneProgressLine,
} from "../../../../src/main/git/git-stderr-progress-receiver";

describe("git stderr progress receiver", () => {
  it("maps Git's five clone progress families to stable phases", () => {
    expect(parseCloneProgressLine("remote: Counting objects: 25% (1/4)")).toMatchObject({
      phase: "counting",
      pct: 25,
      received: 1,
      total: 4,
    });
    expect(parseCloneProgressLine("remote: Compressing objects: 50% (2/4)")).toMatchObject({
      phase: "compressing",
      pct: 50,
    });
    expect(
      parseCloneProgressLine("Receiving objects: 75% (3/4), 12.00 KiB | 1.2 MiB/s"),
    ).toMatchObject({
      phase: "receiving",
      pct: 75,
    });
    expect(parseCloneProgressLine("Resolving deltas: 100% (4/4), done.")).toMatchObject({
      phase: "resolving",
      pct: 100,
    });
    expect(parseCloneProgressLine("Updating files: 100% (4/4), done.")).toMatchObject({
      phase: "checkout",
      pct: 100,
    });
  });

  it("emits phase changes immediately while throttling progress to 20/sec", () => {
    let now = 1_000;
    const receiver = new GitStderrProgressReceiver({ now: () => now });

    const first = receiver.parseLine("Receiving objects: 10% (1/10)");
    const throttled = receiver.parseLine("Receiving objects: 20% (2/10)");
    now += GIT_CLONE_PROGRESS_MIN_INTERVAL_MS;
    const afterWindow = receiver.parseLine("Receiving objects: 30% (3/10)");
    const nextPhase = receiver.parseLine("Resolving deltas: 40% (4/10)");

    expect(first.map((event) => event.kind)).toEqual(["phase", "progress"]);
    expect(throttled).toEqual([]);
    expect(afterWindow).toEqual([
      { kind: "progress", phase: "receiving", pct: 30, received: 3, total: 10 },
    ]);
    expect(nextPhase).toEqual([{ kind: "phase", phase: "resolving" }]);
  });
});
