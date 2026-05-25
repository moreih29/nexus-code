import fs from "node:fs";
import path from "node:path";
import { AgentManifestSchema } from "../../../shared/agent/manifest";
import { LOCAL_AGENT_DIST_DIR } from "./ssh/ssh-bootstrap/types";

/**
 * Electron `app`을 lazy require로 가져온다. 테스트 환경(bun test)은 electron
 * 모듈을 평가하지 않아서 top-level import가 `Export named 'app' not found`
 * 오류를 일으킨다. 호출 시점에만 require하면 테스트 코드가 이 함수를 거치지
 * 않는 한 electron 로드가 발생하지 않는다.
 */
function getElectronApp(): typeof import("electron").app {
  const electron = require("electron") as typeof import("electron");
  return electron.app;
}

/**
 * 에이전트 배포 디렉터리(dist/agent)의 절대 경로를 반환한다.
 *
 * - 패키징된 앱: process.resourcesPath/agent
 * - 개발 환경:   LOCAL_AGENT_DIST_DIR  (cwd/dist/agent)
 *
 * `LOCAL_AGENT_DIST_DIR` 상수는 `process.cwd()` 기준의 dev 기본값이라 패키지
 * 앱(`process.cwd()`가 보통 `/`)에서는 절대 직접 쓰지 말 것. 분기가 필요한
 * 모든 소비자는 이 함수를 거쳐야 한다.
 */
export function getAgentDistDir(): string {
  return getElectronApp().isPackaged
    ? path.join(process.resourcesPath, "agent")
    : LOCAL_AGENT_DIST_DIR;
}

/**
 * 에이전트 배포 디렉터리 안에서 바이너리(래퍼 포함)가 위치하는 bin/ 디렉터리의
 * 절대 경로를 반환한다.
 *
 * - 패키징된 앱: process.resourcesPath/agent/bin
 * - 개발 환경:   LOCAL_AGENT_DIST_DIR/bin  (dist/agent/bin)
 */
export function getAgentBinDir(): string {
  return path.join(getAgentDistDir(), "bin");
}

/**
 * 현재 플랫폼에 맞는 agent 바이너리의 절대 경로를 반환한다.
 *
 * manifest.json에서 현재 os/arch 항목을 찾아 경로를 결정한다.
 * manifest를 파싱할 수 없거나 현재 플랫폼 항목이 없으면 undefined를 반환한다.
 *
 * - 패키징된 앱: process.resourcesPath/agent/<name>
 * - 개발 환경:   LOCAL_AGENT_DIST_DIR/<name>
 */
export function getAgentBinaryPath(): string | undefined {
  const distDir = getAgentDistDir();

  const manifestPath = path.join(distDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return undefined;

  try {
    const manifest = AgentManifestSchema.parse(
      JSON.parse(fs.readFileSync(manifestPath, "utf8")),
    );
    const os =
      process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
    const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : null;
    if (!os || !arch) return undefined;

    const entry = manifest.binaries.find((b) => b.os === os && b.arch === arch);
    if (!entry) return undefined;

    return path.join(distDir, entry.path);
  } catch {
    return undefined;
  }
}
