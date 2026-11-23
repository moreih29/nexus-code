/** The running app's signature: the hash of its designated requirement, as codesign tells it. */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appSignature,
  bundleOf,
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

test("asks codesign about the bundle and keeps the hash of its requirement", async () => {
  const asked: string[][] = [];
  const signature = await appSignature("/A.app/Contents/MacOS/A", async (args) => {
    asked.push(args);
    return `designated => ${DEVELOPER_ID}\n`;
  });
  expect(asked).toEqual([["-d", "-r-", "/A.app"]]);
  expect(signature).toBe(createHash("sha256").update(DEVELOPER_ID).digest("hex"));
});

test.each([
  ["codesign fails", async () => Promise.reject(new Error("not signed"))],
  ["it says no requirement", async () => "Executable=/A.app/Contents/MacOS/A\n"],
])("none where %s", async (_label, run) => {
  expect(await appSignature("/A.app/Contents/MacOS/A", run)).toBeNull();
});
