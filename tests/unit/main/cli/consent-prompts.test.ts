/** The consent prompts waiting on the user, kept by id for another device to answer. */
import { describe, expect, test } from "bun:test";
import { ConsentPrompts } from "../../../../src/main/features/cli/consent-prompts";
import type { CliConsentAnswer, CliUiOps } from "../../../../src/shared/cli/ui";

type AskArgs = CliUiOps["consent.ask"]["args"];

const request: AskArgs = {
  fromWorkspaceId: "w1",
  fromTabId: "t1",
  toWorkspaceId: "w2",
  change: { kind: "chatInput", detail: "Review" },
  timeoutMs: 60_000,
};

function setup() {
  const shown: { args: AskArgs; timeoutMs: number; answer: (a: CliConsentAnswer) => void }[] = [];
  const settled: { id: string; answer: string; by: string }[] = [];
  let settles = true;
  const prompts = new ConsentPrompts({
    ask: (args, timeoutMs) =>
      new Promise((resolve) => {
        shown.push({ args, timeoutMs, answer: (answer) => resolve({ answer }) });
      }),
    settle: async (id, answer, by) => {
      settled.push({ id, answer, by });
      // The renderer answers the prompt it shows, as the user's answer would.
      const prompt = shown.find((s) => s.args.id === id);
      if (settles) prompt?.answer(answer);
      return settles && prompt !== undefined;
    },
    now: () => 1000,
  });
  return {
    prompts,
    shown,
    settled,
    stopSettling: () => {
      settles = false;
    },
  };
}

describe("the consent prompts waiting on the user", () => {
  test("listed by id while they wait, gone once answered", async () => {
    const { prompts, shown } = setup();
    const asked = prompts.ask(request);
    const [prompt] = prompts.list();
    expect(prompt).toMatchObject({ at: 1000, expiresAt: 61_000, request });
    // The renderer is told the id, and waited on a little past its own timeout.
    expect(shown[0]?.args.id).toBe(prompt?.id as string);
    expect(shown[0]?.timeoutMs).toBe(70_000);
    shown[0]?.answer("once");
    expect(await asked).toEqual({ answer: "once" });
    expect(prompts.list()).toEqual([]);
  });

  test("in the order asked; a wait told takes the place of the default", async () => {
    const { prompts, shown } = setup();
    void prompts.ask(request);
    void prompts.ask({ ...request, fromTabId: "t2" }, 5_000);
    expect(prompts.list().map((p) => p.request.fromTabId)).toEqual(["t1", "t2"]);
    expect(shown[1]?.timeoutMs).toBe(5_000);
  });

  test("answered from another device: the prompt shown settles as theirs", async () => {
    const { prompts, settled } = setup();
    const asked = prompts.ask(request);
    const id = prompts.list()[0]?.id as string;
    expect(await prompts.answer(id, "session", "iPhone")).toBe(true);
    expect(settled).toEqual([{ id, answer: "session", by: "iPhone" }]);
    expect(await asked).toEqual({ answer: "session" });
    expect(prompts.list()).toEqual([]);
  });

  test("one that no longer waits is not answered", async () => {
    const { prompts, settled, stopSettling } = setup();
    expect(await prompts.answer("gone", "once", "iPhone")).toBe(false);
    expect(settled).toEqual([]);
    // Listed still, but the renderer took it down meanwhile.
    void prompts.ask(request);
    stopSettling();
    expect(await prompts.answer(prompts.list()[0]?.id as string, "once", "iPhone")).toBe(false);
  });

  test("a prompt the renderer could not show leaves the list too", async () => {
    const prompts = new ConsentPrompts({
      ask: async () => {
        throw new Error("no window");
      },
      settle: async () => false,
    });
    await expect(prompts.ask(request)).rejects.toThrow("no window");
    expect(prompts.list()).toEqual([]);
  });
});
