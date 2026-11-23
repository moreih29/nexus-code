import { describe, expect, test } from "bun:test";
import {
  buildWorkspaceDirUrl,
  buildWorkspaceUrl,
} from "../../../../../../src/renderer/services/editor/preview/workspace-url";

const WS = "a1b2c3d4-e5f6-7890-abcd-ef0123456789";

describe("buildWorkspaceDirUrl — base href for relative resource resolution", () => {
  test("nested directory keeps a trailing slash", () => {
    expect(buildWorkspaceDirUrl(WS, "reports/out")).toBe(`nexus-workspace://${WS}/reports/out/`);
  });

  test("workspace root (empty relDir) yields host + slash", () => {
    expect(buildWorkspaceDirUrl(WS, "")).toBe(`nexus-workspace://${WS}/`);
  });

  test("strips redundant leading/trailing slashes before re-appending one", () => {
    expect(buildWorkspaceDirUrl(WS, "/reports/out/")).toBe(`nexus-workspace://${WS}/reports/out/`);
  });

  test("normalises Windows backslashes", () => {
    expect(buildWorkspaceDirUrl(WS, "reports\\out")).toBe(`nexus-workspace://${WS}/reports/out/`);
  });

  test("percent-encodes spaces and special chars per segment", () => {
    expect(buildWorkspaceDirUrl(WS, "my reports/v2")).toBe(
      `nexus-workspace://${WS}/my%20reports/v2/`,
    );
  });

  test("trailing-slash base resolves a sibling one level deep (URL semantics)", () => {
    const base = buildWorkspaceDirUrl(WS, "reports/out");
    expect(new URL("report.shared.js", base).href).toBe(
      `nexus-workspace://${WS}/reports/out/report.shared.js`,
    );
    const fileStyle = buildWorkspaceUrl(WS, "reports/out");
    expect(new URL("report.shared.js", fileStyle).href).toBe(
      `nexus-workspace://${WS}/reports/report.shared.js`,
    );
  });
});

describe("another computer's workspace", () => {
  test("serves its files by their paths there, under the folder its chat's pane told", async () => {
    const { peerWorkspaceId, setPeerRoot } = await import(
      "../../../../../../src/renderer/services/remote/peer-workspace"
    );
    const { buildOutsideUrl } = await import(
      "../../../../../../src/renderer/services/editor/preview/workspace-url"
    );
    const id = peerWorkspaceId("dev-1", "ws-1");
    const untell = setPeerRoot(id, "C:\\Users\\me\\site");
    expect(buildWorkspaceUrl(id, "img/a.png")).toBe(
      "nexus-workspace://peer/dev-1/ws-1/C%3A/Users/me/site/img/a.png",
    );
    expect(buildWorkspaceDirUrl(id, "pages")).toBe(
      "nexus-workspace://peer/dev-1/ws-1/C%3A/Users/me/site/pages/",
    );
    expect(buildOutsideUrl(id, "/tmp/x.png")).toBe("nexus-workspace://peer/dev-1/ws-1/tmp/x.png");
    untell();
  });
});
