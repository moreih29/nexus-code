import { expect, test } from "bun:test";
import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  CircleX,
  Loader,
  MessageCircleQuestion,
  TriangleAlert,
} from "lucide-react";
import {
  GROUP_STATE,
  GROUP_TINT,
  REMOTE_STATE,
  remoteStateLook,
  runLook,
  stateLook,
} from "../../../../../src/renderer/components/agent-list/state-look";
import enCommon from "../../../../../src/shared/i18n/locales/en/common.json";
import koCommon from "../../../../../src/shared/i18n/locales/ko/common.json";

test("each conversation state has one icon, color and label", () => {
  const rows = Object.fromEntries(
    [
      "permissionPending",
      "needsInput",
      "error",
      "running",
      "busy",
      "completed",
      "exited",
      "idle",
      "quiet",
    ].map((state) => {
      const look = stateLook(state);
      return [state, [look.Icon, look.colorClass, Boolean(look.spin), Boolean(look.pulse)]];
    }),
  );
  expect(rows).toEqual({
    permissionPending: [CircleAlert, "text-(--state-warning-fg)", false, false],
    needsInput: [MessageCircleQuestion, "text-(--tab-claude-attention-fg)", false, true],
    error: [TriangleAlert, "text-(--state-error-fg)", false, false],
    running: [Loader, "text-emerald-500", true, false],
    busy: [Loader, "text-emerald-500", true, false],
    completed: [CircleCheck, "text-(--tab-claude-attention-fg)", false, false],
    exited: [CircleX, "text-muted-foreground", false, false],
    idle: [Circle, "text-muted-foreground", false, false],
    quiet: [Circle, "text-muted-foreground", false, false],
  });
  expect(stateLook("running").labelKey).toBe("common:agentList.state.running");
});

test("runs keep their own words: running and done, not working and new result", () => {
  const states = ["running", "permissionPending", "completed", "failed", "stopped"] as const;
  expect(states.map((state) => runLook(state).Icon)).toEqual([
    Loader,
    CircleAlert,
    CircleCheck,
    CircleX,
    CircleSlash,
  ]);
  expect(runLook("failed").colorClass).toBe("text-(--state-error-fg)");
  expect(runLook("running").labelKey).toBe("common:agentList.agents.state.running");
  expect(koCommon.agentList.agents.state.running).not.toBe(koCommon.agentList.state.running);
});

test("group tints come from the same table as the state glyphs", () => {
  for (const group of ["attention", "running", "done", "idle"] as const) {
    expect(GROUP_TINT[group]).toBe(stateLook(GROUP_STATE[group]).colorClass);
  }
});

test("a remote row reads with the local words and looks", () => {
  for (const [remote, local] of Object.entries(REMOTE_STATE)) {
    const look = remoteStateLook(remote as keyof typeof REMOTE_STATE);
    expect(look).toEqual(stateLook(local));
    expect(look.labelKey.startsWith("common:agentList.state.")).toBe(true);
    const key = local as keyof typeof koCommon.agentList.state;
    expect(koCommon.agentList.state[key]).toBeString();
    expect(enCommon.agentList.state[key as keyof typeof enCommon.agentList.state]).toBeString();
  }
  expect(koCommon.agentList.state[REMOTE_STATE.running as "running"]).toBe("작업 중");
});
