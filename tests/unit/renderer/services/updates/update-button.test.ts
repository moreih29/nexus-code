import { describe, expect, it } from "bun:test";
import { updateButtonOf } from "../../../../../src/renderer/services/updates/update-button";

const newer = {
  kind: "newer",
  trigger: "auto",
  current: "1.0.0",
  latest: "1.1.0",
  releaseUrl: "https://example.invalid/releases/tag/v1.1.0",
  canInstall: true,
} as const;

describe("updateButtonOf", () => {
  it("shows nothing without an update to take", () => {
    expect(updateButtonOf(null, null, null)).toBeNull();
    expect(updateButtonOf({ kind: "checking", trigger: "manual" }, null, null)).toBeNull();
    expect(
      updateButtonOf({ kind: "current", trigger: "auto", current: "1.0.0" }, null, null),
    ).toBeNull();
    expect(
      updateButtonOf({ kind: "error", trigger: "auto", reason: "network" }, null, null),
    ).toBeNull();
  });

  it("offers a newer version, unless the user skipped it", () => {
    expect(updateButtonOf(newer, null, null)).toEqual({ kind: "available", version: "1.1.0" });
    expect(updateButtonOf(newer, null, "1.0.5")).toEqual({ kind: "available", version: "1.1.0" });
    expect(updateButtonOf(newer, null, "1.1.0")).toBeNull();
  });

  it("shows the download, with how far it got once that is known", () => {
    const downloading = { kind: "downloading", version: "1.1.0" } as const;
    expect(updateButtonOf(downloading, null, null)).toEqual({
      kind: "downloading",
      version: "1.1.0",
    });
    const progress = { version: "1.1.0", transferred: 333, total: 1000, bytesPerSecond: 1 };
    expect(updateButtonOf(downloading, progress, null)).toEqual({
      kind: "downloading",
      version: "1.1.0",
      percent: 33,
    });
    // Progress of another version, or of an unknown size, tells nothing.
    expect(updateButtonOf(downloading, { ...progress, version: "1.0.9" }, null)).not.toHaveProperty(
      "percent",
    );
    expect(updateButtonOf(downloading, { ...progress, total: 0 }, null)).not.toHaveProperty(
      "percent",
    );
  });

  it("shows the check, the restart and a failed install, whatever was skipped", () => {
    expect(updateButtonOf({ kind: "verifying", version: "1.1.0" }, null, "1.1.0")).toEqual({
      kind: "verifying",
      version: "1.1.0",
    });
    expect(updateButtonOf({ kind: "ready", version: "1.1.0" }, null, "1.1.0")).toEqual({
      kind: "ready",
      version: "1.1.0",
    });
    expect(
      updateButtonOf({ kind: "installFailed", releaseUrl: "https://example.invalid" }, null, null),
    ).toEqual({ kind: "failed" });
  });
});
