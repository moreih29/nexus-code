/** What an empty composer tells of its keys, and what each does with a message during a turn. */
import { describe, expect, test } from "bun:test";
import i18next from "i18next";

const { composerHint, composerKeys, modelPickerOptions } = await import(
  "../../../../../src/renderer/components/chat/composer"
);

const t = i18next.t.bind(i18next);

describe("the composer's hint", () => {
  test("between turns: send, new line, commands and files; a Codex tab has no commands", () => {
    const { send, newLine } = composerKeys();
    expect(composerHint(t, false, "claude")).toBe(
      `${send} send · ${newLine} new line · / commands · @ files`,
    );
    expect(composerHint(t, false, "codex")).toBe(`${send} send · ${newLine} new line · @ files`);
  });

  test("a Claude tab's turn: Enter waits for the current tool, the now key goes at once, the queue key waits for the turn", () => {
    const { send, nowKey, queueKey } = composerKeys();
    expect(composerHint(t, true, "claude")).toBe(
      `${send} deliver after the current tool · ${nowKey} deliver now · ${queueKey} deliver after the turn`,
    );
  });

  test("a Codex tab's turn: Enter waits for a tool and the now key explains what it discards", () => {
    const { send, nowKey, queueKey } = composerKeys();
    const hint = composerHint(t, true, "codex");
    expect(hint).toBe(
      `${send} after tool · ${nowKey} now (discards current response) · ${queueKey} after turn`,
    );
  });
});

test("hides Claude's duplicate default alias and generic description for a custom connection", () => {
  const defaultModel = {
    value: "default",
    displayName: "Default (recommended)",
    description: "Use the default model (currently glm-5-plus[1m])",
    resolvedModel: "glm-5-plus[1m]",
  };
  const custom = {
    value: "glm-5-plus",
    displayName: "GLM 5 Plus",
    description: "Custom model (glm-5-plus)",
  };
  const models = [defaultModel, custom];
  expect(modelPickerOptions(models, true)).toEqual([{ model: custom, label: "GLM 5 Plus" }]);
  expect(modelPickerOptions(models, false)[0]).toEqual({
    model: defaultModel,
    label: defaultModel.displayName,
    detail: defaultModel.description,
  });
  expect(defaultModel.resolvedModel).toBe("glm-5-plus[1m]");
});
