/**
 * getAgentBinDir() 단위 테스트.
 *
 * electron.app.isPackaged 와 process.resourcesPath 를 mock으로 제어하여
 * 개발 모드(isPackaged=false)와 패키징 모드(isPackaged=true) 경로를 검증한다.
 */

import { describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { LOCAL_AGENT_DIST_DIR } from "../../../../src/main/infra/agent/ssh/ssh-bootstrap/types";

// -------------------------------------------------------------------------
// electron mock — mock.module()은 해당 파일의 모든 import보다 먼저 실행됨.
// -------------------------------------------------------------------------

const FAKE_RESOURCES_PATH = "/Applications/NexusCode.app/Contents/Resources";

mock.module("electron", () => ({
  app: {
    // 기본값: dev 모드 (_isPackaged=false). 개별 테스트에서 _isPackaged를 재정의.
    get isPackaged() {
      return _isPackaged;
    },
  },
}));

// 테스트별로 변경 가능한 상태.
let _isPackaged = false;
const originalResourcesPath = process.resourcesPath;

describe("getAgentBinDir", () => {
  test("개발 모드(isPackaged=false): LOCAL_AGENT_DIST_DIR/bin 반환", async () => {
    _isPackaged = false;
    // 모듈 캐시를 우회하기 위해 dynamic import 사용.
    const { getAgentBinDir } = await import(
      "../../../../src/main/infra/agent/getAgentBinDir"
    );
    const result = getAgentBinDir();
    expect(result).toBe(path.join(LOCAL_AGENT_DIST_DIR, "bin"));
  });

  test("패키징 모드(isPackaged=true): process.resourcesPath/agent/bin 반환", async () => {
    _isPackaged = true;
    // process.resourcesPath 주입.
    Object.defineProperty(process, "resourcesPath", {
      value: FAKE_RESOURCES_PATH,
      configurable: true,
    });

    const { getAgentBinDir } = await import(
      "../../../../src/main/infra/agent/getAgentBinDir"
    );
    const result = getAgentBinDir();
    expect(result).toBe(path.join(FAKE_RESOURCES_PATH, "agent", "bin"));

    // 정리.
    _isPackaged = false;
    Object.defineProperty(process, "resourcesPath", {
      value: originalResourcesPath,
      configurable: true,
    });
  });
});
