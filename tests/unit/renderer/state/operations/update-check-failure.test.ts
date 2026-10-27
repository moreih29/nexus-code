import { describe, expect, it } from "bun:test";
import { updateCheckFailedMessage } from "../../../../../src/renderer/state/operations/update-check-failure";

describe("updateCheckFailedMessage", () => {
  it("words each failure reason without raw detail", () => {
    expect(updateCheckFailedMessage({ reason: "rate-limited", status: 403 })).toBe(
      "Couldn't check for updates. GitHub is limiting requests right now; try again in a moment.",
    );
    expect(updateCheckFailedMessage({ reason: "http", status: 502 })).toBe(
      "Couldn't check for updates (HTTP 502).",
    );
    expect(updateCheckFailedMessage({ reason: "network" })).toBe(
      "Couldn't check for updates. Check your network connection.",
    );
    expect(updateCheckFailedMessage({ reason: "unexpected" })).toBe("Couldn't check for updates.");
  });
});
