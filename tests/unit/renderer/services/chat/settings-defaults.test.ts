/**
 * A Claude tab's program runs as the user's settings say: the model they
 * set shows before the first turn names it, and the effort they set, which
 * `claude -p` leaves out, is given to it. Answers as claude 2.1.319 gave
 * them.
 */

import { describe, expect, test } from "bun:test";
import {
  applyLines,
  type ChatLine,
  currentModelInfo,
  emptyModel,
  type ModelInfo,
} from "../../../../../src/renderer/services/chat/model";
import {
  appliedEffort,
  effortToApply,
  settingsModel,
} from "../../../../../src/renderer/services/chat/settings-defaults";

const SET = {
  effective: { model: "opus[1m]", effortLevel: "xhigh", theme: "dark" },
  sources: [{ source: "userSettings", settings: { model: "opus[1m]", effortLevel: "xhigh" } }],
  applied: { model: "claude-opus-5-5[1m]", effort: "medium", ultracode: false },
};
const UNSET = {
  effective: { theme: "dark" },
  sources: [],
  applied: { model: "claude-opus-4-8", effort: "medium" },
};

describe("settingsModel", () => {
  test("is the model the settings set, as the program runs it", () => {
    expect(settingsModel(SET)).toBe("claude-opus-5-5[1m]");
  });

  test("is none when no setting names one: the default runs", () => {
    expect(settingsModel(UNSET)).toBeUndefined();
    expect(settingsModel(null)).toBeUndefined();
  });
});

describe("effortToApply", () => {
  test("is the settings' effort the program does not run at", () => {
    expect(effortToApply(SET)).toBe("xhigh");
    expect(appliedEffort(SET)).toBe("medium");
  });

  test("is the model's own when the settings keep one (as /effort saves it)", () => {
    const perModel = {
      ...SET,
      effective: { ...SET.effective, modelSettings: { "claude-opus-5-5": { effortLevel: "low" } } },
    };
    // A headless run takes the model's own already: nothing to set.
    expect(
      effortToApply({ ...perModel, applied: { ...SET.applied, effort: "low" } }),
    ).toBeUndefined();
    expect(effortToApply(perModel)).toBe("low");
  });

  test("is none when the program runs at it, or the settings set none", () => {
    expect(effortToApply({ ...SET, applied: { effort: "xhigh" } })).toBeUndefined();
    expect(effortToApply(UNSET)).toBeUndefined();
    expect(effortToApply(undefined)).toBeUndefined();
  });
});

const MODELS: ModelInfo[] = [
  { value: "default", resolvedModel: "claude-opus-4-8", displayName: "Default (recommended)" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" },
  { value: "claude-opus-5", resolvedModel: "claude-opus-5", displayName: "Opus 5" },
  { value: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6", displayName: "Sonnet 4.6" },
] as ModelInfo[];

describe("currentModelInfo", () => {
  test("a long-context id is its model's", () => {
    expect(currentModelInfo(MODELS, "claude-opus-5-5[1m]")?.displayName).toBe("Opus 5.5");
    expect(currentModelInfo(MODELS, "opus[1m]")?.displayName).toBe("Opus 5.5");
  });

  test("a dated id is the model with the longest name it starts with", () => {
    expect(currentModelInfo(MODELS, "claude-sonnet-4-6-20260101")?.displayName).toBe("Sonnet 4.6");
    expect(currentModelInfo(MODELS, "claude-opus-5-20260101")?.displayName).toBe("Opus 5");
  });

  test("no model yet is the default", () => {
    expect(currentModelInfo(MODELS, undefined)?.value).toBe("default");
  });
});

function answered(answer: unknown, model = emptyModel()) {
  const lines: ChatLine[] = [
    { seq: 1, dir: "sys", message: { event: "start", pid: 1 } },
    {
      seq: 2,
      dir: "in",
      message: { type: "control_request", request_id: "g", request: { subtype: "get_settings" } },
    },
    {
      seq: 3,
      dir: "out",
      message: {
        type: "control_response",
        response: { subtype: "success", request_id: "g", response: answer },
      },
    },
  ];
  return applyLines(model, lines);
}

describe("a get_settings answer", () => {
  test("tells the tab the model and effort before the first turn", () => {
    const model = answered(SET);
    expect(model.model).toBe("claude-opus-5-5[1m]");
    expect(model.effort).toBe("medium");
  });

  test("leaves the default shown when no setting names a model", () => {
    expect(answered(UNSET).model).toBeUndefined();
  });

  test("does not undo a model or effort the session already told", () => {
    const model = answered(SET, { ...emptyModel(), model: "claude-haiku-5-5", effort: "high" });
    expect(model.model).toBe("claude-haiku-5-5");
    expect(model.effort).toBe("high");
  });
});
