import { describe, expect, it } from "bun:test";
import {
  SaveSequentializer,
  SaveSupersededError,
} from "../../../../../src/renderer/services/editor/save-sequentializer";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SaveSequentializer", () => {
  it("runs a single task and resolves its result", async () => {
    const seq = new SaveSequentializer();
    const result = await seq.run("a", async () => 42);
    expect(result).toBe(42);
    expect(seq.isRunning("a")).toBe(false);
  });

  it("isRunning returns true while in-flight, false after settle", async () => {
    const seq = new SaveSequentializer();
    const d = deferred<number>();
    const p = seq.run("a", () => d.promise);
    expect(seq.isRunning("a")).toBe(true);
    d.resolve(1);
    await p;
    expect(seq.isRunning("a")).toBe(false);
  });

  it("aborts running task and runs queued fn after it settles", async () => {
    const seq = new SaveSequentializer();
    const aborts: boolean[] = [];

    const first = deferred<string>();
    const p1 = seq.run("a", (signal) => {
      signal.addEventListener("abort", () => aborts.push(true));
      return first.promise;
    });

    let secondRan = false;
    const p2 = seq.run("a", async () => {
      secondRan = true;
      return "second";
    });

    expect(aborts).toEqual([true]);
    expect(secondRan).toBe(false);

    first.resolve("first");
    await p1;
    const result = await p2;
    expect(result).toBe("second");
    expect(seq.isRunning("a")).toBe(false);
  });

  it("third concurrent run supersedes the queued second", async () => {
    const seq = new SaveSequentializer();
    const first = deferred<string>();
    const p1 = seq.run("a", () => first.promise);
    const p2 = seq.run("a", async () => "second");
    const p3 = seq.run("a", async () => "third");

    await expect(p2).rejects.toBeInstanceOf(SaveSupersededError);

    first.resolve("first-done");
    await p1;
    const result = await p3;
    expect(result).toBe("third");
  });

  it("isolates keys — different files run concurrently", async () => {
    const seq = new SaveSequentializer();
    const dA = deferred<string>();
    const dB = deferred<string>();
    const pA = seq.run("a", () => dA.promise);
    const pB = seq.run("b", () => dB.promise);
    expect(seq.isRunning("a")).toBe(true);
    expect(seq.isRunning("b")).toBe(true);
    dA.resolve("A");
    dB.resolve("B");
    expect(await pA).toBe("A");
    expect(await pB).toBe("B");
  });

  it("propagates rejection of running task", async () => {
    const seq = new SaveSequentializer();
    const p = seq.run("a", async () => {
      throw new Error("boom");
    });
    await expect(p).rejects.toThrow("boom");
    expect(seq.isRunning("a")).toBe(false);
  });

  it("queued task still runs after running task rejects", async () => {
    const seq = new SaveSequentializer();
    const first = deferred<string>();
    const p1 = seq.run("a", () => first.promise);
    const p2 = seq.run("a", async () => "second");

    first.reject(new Error("boom"));
    await expect(p1).rejects.toThrow("boom");
    const result = await p2;
    expect(result).toBe("second");
  });
});
