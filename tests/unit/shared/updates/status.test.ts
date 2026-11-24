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

  test("keeps an offer through a check that is running or failed, and takes a newer one", () => {
    const offer: UpdateStatus = {
      kind: "newer",
      trigger: "auto",
      current: "1.0.0",
      latest: "1.1.0",
      releaseUrl: "https://example.invalid/v1.1.0",
      canInstall: true,
    };
    const later: UpdateStatus = { ...offer, trigger: "manual", latest: "1.2.0" };

    expect(nextUpdateStatus(offer, { kind: "checking", trigger: "manual" })).toEqual(offer);
    expect(
      nextUpdateStatus(offer, { kind: "error", trigger: "manual", reason: "network" }),
    ).toEqual(offer);
    expect(nextUpdateStatus(offer, later)).toEqual(later);
    expect(nextUpdateStatus(offer, downloading)).toEqual(downloading);
  });
});
