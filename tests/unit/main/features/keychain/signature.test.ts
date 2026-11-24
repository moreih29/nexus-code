import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appSignature,
  bundleOf,
  CODESIGN_TIMEOUTS_MS,
  designatedRequirement,
} from "../../../../../src/main/features/keychain/signature";

const DEVELOPER_ID =
  'identifier "com.example.app" and anchor apple generic and certificate leaf[subject.OU] = ABCDE12345';

test("the bundle an executable is in", () => {
  expect(bundleOf("/Applications/NexusCode.app/Contents/MacOS/NexusCode")).toBe(
    "/Applications/NexusCode.app",
  );
  expect(bundleOf("/usr/local/bin/tool")).toBe("/usr/local/bin/tool");
});

test.each([
  [`Executable=/A.app/Contents/MacOS/A\ndesignated => ${DEVELOPER_ID}\n`, DEVELOPER_ID],
  ['# designated => cdhash H"0123abcd"', 'cdhash H"0123abcd"'],
  ["code object is not signed at all", null],
])("reads the designated requirement from codesign's output", (output, requirement) => {
  expect(designatedRequirement(output)).toBe(requirement);
});

const HASH = createHash("sha256").update(DEVELOPER_ID).digest("hex");

test("asks codesign about the bundle and keeps the hash of its requirement", async () => {
  const asked: [string[], number][] = [];
  const signature = await appSignature("/A.app/Contents/MacOS/A", async (args, timeoutMs) => {
    asked.push([args, timeoutMs]);
    return `designated => ${DEVELOPER_ID}\n`;
  });
  expect(asked).toEqual([[["-d", "-r-", "/A.app"], CODESIGN_TIMEOUTS_MS[0]]]);
  expect(signature).toBe(HASH);
});

test("asks again with a longer wait when codesign fails or times out the first time", async () => {
  const waits: number[] = [];
  const signature = await appSignature("/A.app/Contents/MacOS/A", async (_args, timeoutMs) => {
    waits.push(timeoutMs);
    if (waits.length === 1) throw new Error("timed out");
    return `designated => ${DEVELOPER_ID}\n`;
  });
  expect(waits).toEqual([...CODESIGN_TIMEOUTS_MS]);
  expect(CODESIGN_TIMEOUTS_MS[1]).toBeGreaterThan(CODESIGN_TIMEOUTS_MS[0]);
  expect(signature).toBe(HASH);
});

test("none once every try fails", async () => {
  let tries = 0;
  const signature = await appSignature("/A.app/Contents/MacOS/A", async () => {
    tries++;
    throw new Error("not signed");
  });
  expect(signature).toBeNull();
  expect(tries).toBe(CODESIGN_TIMEOUTS_MS.length);
});

test("none, without asking again, when codesign answers with no requirement", async () => {
  let tries = 0;
  const signature = await appSignature("/A.app/Contents/MacOS/A", async () => {
    tries++;
    return "Executable=/A.app/Contents/MacOS/A\n";
  });
  expect(signature).toBeNull();
  expect(tries).toBe(1);
});
