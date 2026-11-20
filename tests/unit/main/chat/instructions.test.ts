import { expect, test } from "bun:test";
import {
  claudeInstructionLaunch,
  claudeInstructionUpdate,
} from "../../../../src/main/features/chat/instructions";

test("Claude adds changed instructions once and restores them after a compact", () => {
  const launch = claudeInstructionLaunch("system instructions");
  expect(claudeInstructionUpdate(launch, undefined, "system instructions", false)).toBeUndefined();
  const update = claudeInstructionUpdate(launch, undefined, "updated instructions", false);
  expect(update?.text).toEndWith("\n\nupdated instructions");
  expect(
    claudeInstructionUpdate(launch, update?.digest, "updated instructions", false),
  ).toBeUndefined();
  expect(claudeInstructionUpdate(launch, update?.digest, "updated instructions", true)).toEqual(
    update,
  );
  expect(claudeInstructionUpdate(launch, update?.digest, "", false)?.text).toContain(
    "were cleared",
  );
  const resumed = claudeInstructionLaunch("updated instructions");
  expect(
    claudeInstructionUpdate(resumed, undefined, "updated instructions", false),
  ).toBeUndefined();
});
