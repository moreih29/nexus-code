/**
 * Unit tests for the nexus-workspace:// URL builders.
 *
 * The HTML preview injects `buildWorkspaceDirUrl(...)` as an iframe `<base href>`
 * so relatively-referenced sibling resources (`<script src>`, `<link href>`)
 * resolve against the file's on-disk directory. The TRAILING SLASH is the
 * load-bearing invariant: without it, a relative `x.js` resolves one directory
 * too high. These tests pin that contract.
 */

import { describe, expect, test } from "bun:test";
import {
  buildWorkspaceDirUrl,
  buildWorkspaceUrl,
} from "../../../../../../src/renderer/services/editor/preview/workspace-url";

const WS = "a1b2c3d4-e5f6-7890-abcd-ef0123456789";

describe("buildWorkspaceDirUrl — base href for relative resource resolution", () => {
  test("nested directory keeps a trailing slash", () => {
    expect(buildWorkspaceDirUrl(WS, "reports/out")).toBe(
      `nexus-workspace://${WS}/reports/out/`,
    );
  });

  test("workspace root (empty relDir) yields host + slash", () => {
    expect(buildWorkspaceDirUrl(WS, "")).toBe(`nexus-workspace://${WS}/`);
  });

  test("strips redundant leading/trailing slashes before re-appending one", () => {
    expect(buildWorkspaceDirUrl(WS, "/reports/out/")).toBe(
      `nexus-workspace://${WS}/reports/out/`,
    );
  });

  test("normalises Windows backslashes", () => {
    expect(buildWorkspaceDirUrl(WS, "reports\\out")).toBe(
      `nexus-workspace://${WS}/reports/out/`,
    );
  });

  test("percent-encodes spaces and special chars per segment", () => {
    expect(buildWorkspaceDirUrl(WS, "my reports/v2")).toBe(
      `nexus-workspace://${WS}/my%20reports/v2/`,
    );
  });

  test("trailing-slash base resolves a sibling one level deep (URL semantics)", () => {
    // The whole point: new URL(relative, base) must land in the dir, not above.
    const base = buildWorkspaceDirUrl(WS, "reports/out");
    expect(new URL("report.shared.js", base).href).toBe(
      `nexus-workspace://${WS}/reports/out/report.shared.js`,
    );
    // Contrast: the file-style builder (no trailing slash) would resolve wrong.
    const fileStyle = buildWorkspaceUrl(WS, "reports/out");
    expect(new URL("report.shared.js", fileStyle).href).toBe(
      `nexus-workspace://${WS}/reports/report.shared.js`,
    );
  });
});
