/**
 * nexus-workspace:// custom protocol handler 단위 테스트.
 *
 * buildNexusWorkspaceHandler를 DI 형태로 직접 호출해 Electron 앱 컨텍스트
 * 없이 핸들러 로직을 검증한다.  fs는 임시 디렉터리에 실제 파일을 만들어
 * 사용하므로 mocking 없이 path traversal / symlink escape까지 검증 가능하다.
 *
 * - case 1: 정상 — workspaceId 존재 + relPath 내부 파일 → 200 + 올바른 MIME
 * - case 2: workspaceId 미존재 → 404
 * - case 3: relPath = "../outside.png" (path traversal) → 404
 * - case 4: relPath = "/etc/passwd" (절대 경로 삽입) → 404
 * - case 5: SSH 워크스페이스 (location.kind === "ssh") → 404
 * - case 6: MIME 추론 — .png → image/png, .svg → image/svg+xml,
 *           .unknown → application/octet-stream
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Electron mock — net.fetch を stub して file:// URL をローカルで処理する.
// protocol / app は登録呼び出しのみなので no-op で充分.
// ---------------------------------------------------------------------------

// net.fetch のモック: file:// URL に対して実際のファイルを返す
const netFetchMock = async (url: string): Promise<Response> => {
  // file:// → ローカルファイル読み込み
  const filePath = new URL(url).pathname;
  try {
    const buf = await fs.promises.readFile(filePath);
    return new Response(buf, { status: 200 });
  } catch {
    return new Response(null, { status: 404 });
  }
};

import { mock } from "bun:test";

mock.module("electron", () => ({
  app: { isPackaged: false },
  net: { fetch: netFetchMock },
  protocol: {
    registerSchemesAsPrivileged: () => {},
    handle: () => {},
  },
}));

// dynamic import — mock.module 이후
const { buildNexusWorkspaceHandler } = await import(
  "../../../../../src/main/features/custom-protocols/nexus-workspace"
);

// ---------------------------------------------------------------------------
// Test fixture — 임시 워크스페이스 루트 및 바깥 파일
// ---------------------------------------------------------------------------

let tmpRoot: string;
let outsideDir: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nx-ws-test-"));
  // 워크스페이스 내부 파일들
  fs.writeFileSync(path.join(tmpRoot, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(tmpRoot, "icon.svg"), "<svg/>");
  fs.writeFileSync(path.join(tmpRoot, "data.unknown"), "bytes");
  // nested dir
  fs.mkdirSync(path.join(tmpRoot, "sub"), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, "sub", "nested.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  // 워크스페이스 바깥 파일 (path traversal 대상)
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "nx-outside-test-"));
  fs.writeFileSync(path.join(outsideDir, "outside.png"), "outside");
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

// ---------------------------------------------------------------------------
// WorkspaceManager mock factory
// ---------------------------------------------------------------------------

type LocationKind = "local" | "ssh";

function makeWorkspaceManager(opts: { id: string; kind: LocationKind; rootPath?: string }) {
  const meta =
    opts.kind === "local"
      ? {
          id: opts.id,
          location: { kind: "local" as const, rootPath: opts.rootPath ?? tmpRoot },
          rootPath: opts.rootPath ?? tmpRoot,
        }
      : {
          id: opts.id,
          location: {
            kind: "ssh" as const,
            host: "example.com",
            user: "user",
            remotePath: "/remote/path",
            authMode: "key-only" as const,
          },
          rootPath: "/remote/path",
        };

  return {
    list: () => [meta],
  } as unknown as import("../../../../../src/main/features/workspace/manager").WorkspaceManager;
}

function makeEmptyWorkspaceManager() {
  return {
    list: () => [],
  } as unknown as import("../../../../../src/main/features/workspace/manager").WorkspaceManager;
}

// ---------------------------------------------------------------------------
// Helper: fire a fake Request at the handler
// ---------------------------------------------------------------------------

function makeRequest(url: string): Request {
  return new Request(url);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildNexusWorkspaceHandler", () => {
  describe("case 1 — 정상: local workspace, 내부 파일", () => {
    test("image.png → 200 + image/png", async () => {
      const wsId = "aaaaaaaa-0000-0000-0000-000000000001";
      const handler = buildNexusWorkspaceHandler(makeWorkspaceManager({ id: wsId, kind: "local" }));

      const resp = await handler(makeRequest(`nexus-workspace://${wsId}/image.png`));
      expect(resp.status).toBe(200);
      expect(resp.headers.get("Content-Type")).toBe("image/png");
    });

    test("sub/nested.png → 200 + image/png (nested path)", async () => {
      const wsId = "aaaaaaaa-0000-0000-0000-000000000002";
      const handler = buildNexusWorkspaceHandler(makeWorkspaceManager({ id: wsId, kind: "local" }));

      const resp = await handler(makeRequest(`nexus-workspace://${wsId}/sub/nested.png`));
      expect(resp.status).toBe(200);
      expect(resp.headers.get("Content-Type")).toBe("image/png");
    });
  });

  describe("case 2 — workspaceId 미존재", () => {
    test("unknown workspace id → 404", async () => {
      const handler = buildNexusWorkspaceHandler(makeEmptyWorkspaceManager());
      const resp = await handler(makeRequest("nexus-workspace://does-not-exist/image.png"));
      expect(resp.status).toBe(404);
    });
  });

  describe("case 3 — path traversal (../outside.png)", () => {
    test("relPath escaping rootPath via encoded slash (..%2F) → 404 (traversal guard fires)", async () => {
      const wsId = "aaaaaaaa-0000-0000-0000-000000000003";

      // Use the 'sub' subdirectory of tmpRoot as the workspace root.
      // tmpRoot/image.png is a real file that is OUTSIDE sub/.
      // URL: "..%2Fimage.png" — the URL parser does NOT collapse "..%2F"
      // because the slash is encoded; decodeURIComponent turns it into
      // "../image.png" which path.resolve then walks up one level.
      const subRoot = path.join(tmpRoot, "sub");
      const handler = buildNexusWorkspaceHandler(
        makeWorkspaceManager({ id: wsId, kind: "local", rootPath: subRoot }),
      );

      // "..%2Fimage.png" → after slice(1) + split('/') + map(decode):
      //   [ "../image.png" ] → joined: "../image.png"
      //   path.resolve(subRoot, "../image.png") = tmpRoot/image.png → OUTSIDE
      const resp = await handler(makeRequest(`nexus-workspace://${wsId}/..%2Fimage.png`));
      expect(resp.status).toBe(404);
    });
  });

  describe("case 4 — 절대 경로 삽입 (/etc/passwd)", () => {
    test("absolute relPath → 404", async () => {
      const wsId = "aaaaaaaa-0000-0000-0000-000000000004";
      const handler = buildNexusWorkspaceHandler(makeWorkspaceManager({ id: wsId, kind: "local" }));

      // /etc/passwd — after stripping leading "/" from pathname the relPath
      // becomes "etc/passwd" which resolves inside rootPath if rootPath were
      // "/", but since rootPath is tmpRoot it should stay safely inside.
      // Test the raw absolute path by percent-encoding the leading slash so it
      // appears as a segment: %2Fetc%2Fpasswd
      const resp = await handler(
        makeRequest(`nexus-workspace://${wsId}/${encodeURIComponent("/etc/passwd")}`),
      );
      // path.resolve(tmpRoot, "/etc/passwd") === "/etc/passwd" which is
      // outside rootPath → 404
      expect(resp.status).toBe(404);
    });
  });

  describe("case 5 — SSH workspace → 404", () => {
    test("location.kind === 'ssh' → 404", async () => {
      const wsId = "aaaaaaaa-0000-0000-0000-000000000005";
      const handler = buildNexusWorkspaceHandler(makeWorkspaceManager({ id: wsId, kind: "ssh" }));
      const resp = await handler(makeRequest(`nexus-workspace://${wsId}/image.png`));
      expect(resp.status).toBe(404);
    });
  });

  describe("case 6 — MIME 추론", () => {
    test(".png → image/png", async () => {
      const wsId = "aaaaaaaa-0000-0000-0000-000000000006";
      const handler = buildNexusWorkspaceHandler(makeWorkspaceManager({ id: wsId, kind: "local" }));
      const resp = await handler(makeRequest(`nexus-workspace://${wsId}/image.png`));
      expect(resp.status).toBe(200);
      expect(resp.headers.get("Content-Type")).toBe("image/png");
    });

    test(".svg → image/svg+xml", async () => {
      const wsId = "aaaaaaaa-0000-0000-0000-000000000007";
      const handler = buildNexusWorkspaceHandler(makeWorkspaceManager({ id: wsId, kind: "local" }));
      const resp = await handler(makeRequest(`nexus-workspace://${wsId}/icon.svg`));
      expect(resp.status).toBe(200);
      expect(resp.headers.get("Content-Type")).toBe("image/svg+xml");
    });

    test(".unknown → application/octet-stream", async () => {
      const wsId = "aaaaaaaa-0000-0000-0000-000000000008";
      const handler = buildNexusWorkspaceHandler(makeWorkspaceManager({ id: wsId, kind: "local" }));
      const resp = await handler(makeRequest(`nexus-workspace://${wsId}/data.unknown`));
      expect(resp.status).toBe(200);
      expect(resp.headers.get("Content-Type")).toBe("application/octet-stream");
    });
  });
});
