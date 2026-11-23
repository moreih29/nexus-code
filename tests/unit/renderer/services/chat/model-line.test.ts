import { describe, expect, test } from "bun:test";
import { emptyModel } from "../../../../../src/renderer/services/chat/model";
import { modelLineOf, modelLineOfTab } from "../../../../../src/renderer/services/chat/model-line";

describe("modelLineOf", () => {
  test("joins the effort to the model", () => {
    expect(modelLineOf("claude-opus-5-5", "xhigh", ["high", "xhigh"])).toBe(
      "claude-opus-5-5 · xhigh",
    );
  });
  test("an unknown list takes a set effort", () => {
    expect(modelLineOf("gpt-5.5", "high")).toBe("gpt-5.5 · high");
  });
  test("no effort, or a model taking none, shows the model alone", () => {
    expect(modelLineOf("gpt-5.5", undefined, ["high"])).toBe("gpt-5.5");
    expect(modelLineOf("haiku", "high", [])).toBe("haiku");
  });
  test("no model shows nothing", () => {
    expect(modelLineOf(undefined, "high", ["high"])).toBeUndefined();
  });
});

describe("modelLineOfTab", () => {
  test("reads the efforts from the listed model", () => {
    const init = {
      models: [{ value: "opus", supportedEffortLevels: ["high"] }, { value: "haiku" }],
    } as never;
    const base = { ...emptyModel(), init, effort: "high" };
    expect(modelLineOfTab({ ...base, model: "opus" })).toBe("opus · high");
    expect(modelLineOfTab({ ...base, model: "haiku" })).toBe("haiku");
    expect(modelLineOfTab({ ...emptyModel(), model: "gpt-5.5", effort: "low" })).toBe(
      "gpt-5.5 · low",
    );
  });
});
