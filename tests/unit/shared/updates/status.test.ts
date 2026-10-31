import { describe, expect, test } from "bun:test";
import { nextUpdateStatus, type UpdateStatus } from "../../../../src/shared/updates/status";

const current: UpdateStatus = { kind: "current", trigger: "manual", current: "1.0.0" };
const downloading: UpdateStatus = { kind: "downloading", version: "1.1.0" };

describe("nextUpdateStatus", () => {
  test("takes the latest status", () => {
    expect(nextUpdateStatus(null, current)).toEqual(current);
    expect(nextUpdateStatus(current, downloading)).toEqual(downloading);
  });

  test("keeps an update under way over a later check", () => {
    const ready: UpdateStatus = { kind: "ready", version: "1.1.0" };

    expect(nextUpdateStatus(downloading, current)).toEqual(downloading);
    expect(nextUpdateStatus(ready, { kind: "checking", trigger: "manual" })).toEqual(ready);
  });

  test("lets a check replace a failed install", () => {
    const failed: UpdateStatus = { kind: "installFailed", releaseUrl: "https://example.invalid" };

    expect(nextUpdateStatus(downloading, failed)).toEqual(failed);
    expect(nextUpdateStatus(failed, current)).toEqual(current);
  });
});
