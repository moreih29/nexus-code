import { expect, test } from "bun:test";
import {
  claudeInstructionLaunch,
  claudeInstructionLaunchState,
  claudeInstructionUpdate,
} from "../../../../src/main/features/chat/instructions";

test("Claude adds changed instructions once and restores them after a compact", () => {
  const launch = claudeInstructionLaunchState(claudeInstructionLaunch("system instructions"))!;
  expect(
    claudeInstructionUpdate(launch.systemDigest, undefined, "system instructions", false),
  ).toBeUndefined();
  const update = claudeInstructionUpdate(
    launch.systemDigest,
    undefined,
    "updated instructions",
    false,
  );
  expect(update?.text).toEndWith("\n\nupdated instructions");
  expect(
    claudeInstructionUpdate(launch.systemDigest, update?.digest, "updated instructions", false),
  ).toBeUndefined();
  expect(
    claudeInstructionUpdate(launch.systemDigest, update?.digest, "updated instructions", true),
  ).toEqual(update);
  expect(claudeInstructionUpdate(launch.systemDigest, update?.digest, "", false)?.text).toContain(
    "were cleared",
  );
});
