import { expect, test } from "bun:test";
import { ipcContract } from "../../../../src/shared/ipc/contract";
import { AppStateSchema } from "../../../../src/shared/types/app-state";

test("recording summaries default off for absent or invalid stored settings", () => {
  const defaults = { enabled: false, agent: "claude" };
  expect(AppStateSchema.parse({}).noteSummary).toEqual(defaults);
  expect(
    AppStateSchema.parse({ noteSummary: { enabled: true, agent: "codex" } }).noteSummary,
  ).toEqual(defaults);
  const enabled = { enabled: true, agent: "claude", profileId: "qa", model: "haiku" };
  expect(AppStateSchema.parse({ noteSummary: enabled }).noteSummary).toEqual(enabled);
  expect(ipcContract.appState.call.set.args.parse({ noteTranscriptWidth: 500 })).not.toHaveProperty(
    "noteSummary",
  );
});
