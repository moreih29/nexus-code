import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { AgentManifestSchema } from "../../../shared/agent/manifest";
import { LOCAL_AGENT_DIST_DIR } from "./ssh/ssh-bootstrap/types";

/**
 * 에이전트 배포 디렉터리 안에서 바이너리(래퍼 포함)가 위치하는 bin/ 디렉터리의
 * 절대 경로를 반환한다.
 *
 * - 패키징된 앱: process.resourcesPath/agent/bin
 * - 개발 환경:   LOCAL_AGENT_DIST_DIR/bin  (dist/agent/bin)
 */
export function getAgentBinDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "agent", "bin")
    : path.join(LOCAL_AGENT_DIST_DIR, "bin");
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
  const distDir = app.isPackaged
    ? path.join(process.resourcesPath, "agent")
    : LOCAL_AGENT_DIST_DIR;

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
