/**
 * A message of the list renders again only when its part of the list's
 * sources changes: a call of another message's changing leaves it as it
 * was, one of its own, or one under its subagent's call, does not.
 */
import { describe, expect, test } from "bun:test";
import {
  callsUnder,
  type ItemView,
  itemView,
  type ListSources,
  sameView,
} from "../../../../../src/renderer/services/chat/item-view";
import type {
  AssistantItem,
  ChatItem,
  ToolCall,
} from "../../../../../src/renderer/services/chat/model";
import type { AnswerExtras } from "../../../../../src/renderer/services/chat/panel";
import { foldToolRuns } from "../../../../../src/renderer/services/chat/tool-runs";

const call = (id: string, extra: Partial<ToolCall> = {}): ToolCall =>
  ({
    id,
    name: "Bash",
    input: { command: `echo ${id}` },
    status: "running",
    parentToolUseId: null,
    ...extra,
  }) as ToolCall;

const answer = (key: string, ...calls: string[]): AssistantItem => ({
  kind: "assistant",
  key,
  messageId: key,
  blocks: [
    { type: "text", text: `answer ${key}` },
    ...calls.map((toolUseId) => ({ type: "tool" as const, toolUseId })),
  ],
});

const user: ChatItem = { kind: "user", key: "u", text: "go", images: [], state: "taken" };

function sources(
  items: ChatItem[],
  tools: Record<string, ToolCall>,
  extra: Partial<ListSources> = {},
): ListSources {
  return {
    tools,
    callsUnder: callsUnder(tools),
    shown: foldToolRuns(items, tools),
    extras: new Map(),
    earlier: { byPart: new Map(), inLastTurn: new Set() },
    ...extra,
  };
}

/** Whether `item` renders again going from `before` to `after`. */
function rendersAgain(item: ChatItem, before: ListSources, after: ListSources): boolean {
  return !sameView(itemView(item, before), itemView(item, after));
}

describe("itemView", () => {
  const a = answer("a", "c1");
  const b = answer("b", "c2");
  const items = [user, a, b];
  const tools = { c1: call("c1"), c2: call("c2") };

  test("a call of another message's changing leaves a message as it was", () => {
    const next = { ...tools, c2: call("c2", { status: "done" }) };
    expect(rendersAgain(a, sources(items, tools), sources(items, next))).toBe(false);
    expect(rendersAgain(b, sources(items, tools), sources(items, next))).toBe(true);
  });

  test("a call under its subagent's call changing renders it again", () => {
    const agent = { ...tools, c1: call("c1", { name: "Agent" }) };
    const sub = { ...agent, s1: call("s1", { parentToolUseId: "c1" }) };
    expect(rendersAgain(a, sources(items, agent), sources(items, sub))).toBe(true);
    const done = { ...sub, s1: call("s1", { parentToolUseId: "c1", status: "done" }) };
    expect(rendersAgain(a, sources(items, sub), sources(items, done))).toBe(true);
    expect(itemView(a, sources(items, done))?.tools).toEqual({ c1: done.c1, s1: done.s1 });
    expect(rendersAgain(b, sources(items, sub), sources(items, done))).toBe(false);
  });

  test("calls folded into a run render with the message the run is in", () => {
    // Text, then calls in a row across three messages: the run is in the first.
    const first: AssistantItem = {
      kind: "assistant",
      key: "r1",
      messageId: "r1",
      blocks: [
        { type: "text", text: "looking" },
        { type: "tool", toolUseId: "r-1" },
      ],
    };
    const second: AssistantItem = {
      kind: "assistant",
      key: "r2",
      messageId: "r2",
      blocks: [{ type: "tool", toolUseId: "r-2" }],
    };
    const run = [user, first, second];
    const before = { "r-1": call("r-1"), "r-2": call("r-2") };
    const after = { ...before, "r-2": call("r-2", { status: "done" }) };
    expect(itemView(second, sources(run, before))?.blocks).toEqual([]);
    expect(rendersAgain(first, sources(run, before), sources(run, after))).toBe(true);
    expect(rendersAgain(second, sources(run, before), sources(run, after))).toBe(false);
  });

  test("the same files under an answer, made again, leave it as it was", () => {
    const extras = (files: string[]): Map<ChatItem, AnswerExtras> =>
      new Map([[b, { files, images: [] }]]);
    const one = sources(items, tools, { extras: extras(["/w/a.ts"]) });
    expect(rendersAgain(b, one, sources(items, tools, { extras: extras(["/w/a.ts"]) }))).toBe(
      false,
    );
    expect(
      rendersAgain(b, one, sources(items, tools, { extras: extras(["/w/a.ts", "/w/b.ts"]) })),
    ).toBe(true);
  });

  test("the same images shown before, made again, leave it as it was", () => {
    const earlier = (files: string[]) => ({
      byPart: new Map([["c2", new Set(files)]]),
      inLastTurn: new Set<string>(),
    });
    const one = sources(items, tools, { earlier: earlier(["/w/shot.png"]) });
    expect(rendersAgain(b, one, sources(items, tools, { earlier: earlier(["/w/shot.png"]) }))).toBe(
      false,
    );
    expect(
      rendersAgain(b, one, sources(items, tools, { earlier: earlier(["/w/other.png"]) })),
    ).toBe(true);
    expect(
      rendersAgain(a, one, sources(items, tools, { earlier: earlier(["/w/other.png"]) })),
    ).toBe(false);
  });

  test("the side panel asking for a call renders only the message whose run holds it", () => {
    const first: AssistantItem = {
      kind: "assistant",
      key: "r1",
      messageId: "r1",
      blocks: [
        { type: "tool", toolUseId: "r-1" },
        { type: "tool", toolUseId: "r-2" },
      ],
    };
    const run = [user, first, b];
    const all = { ...tools, "r-1": call("r-1"), "r-2": call("r-2") };
    const ask = { ids: new Set(["r-2"]) };
    const asked = sources(run, all, { asked: ask });
    expect(itemView(first, asked)?.asked).toBe(ask);
    expect(rendersAgain(first, sources(run, all), asked)).toBe(true);
    expect(rendersAgain(b, sources(run, all), asked)).toBe(false);
  });

  test("a message that is not an answer renders from itself alone", () => {
    expect(itemView(user, sources(items, tools))).toBeUndefined();
  });
});

describe("sameView", () => {
  test("its own blocks changing renders it again", () => {
    const view: ItemView = { blocks: [{ type: "text", text: "a" }], tools: {}, earlier: new Map() };
    expect(sameView(view, { ...view })).toBe(true);
    expect(sameView(view, { ...view, blocks: [{ type: "text", text: "a" }] })).toBe(false);
  });
});
