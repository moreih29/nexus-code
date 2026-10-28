// electron-builder afterPack 훅.
//
// extraResources(dist/agent)를 .app/Contents/Resources/agent 로 복사할 때
// 실행 비트(+x)가 떨어져, 번들된 Go 에이전트 바이너리와 bin/ 래퍼가 0644 로
// 들어간다. 로컬 채널(local-channel.ts)은 이 바이너리를 자식 프로세스로 spawn
// 하므로, +x 가 없으면 EACCES 로 실패하고 "Remote agent failed to start" 로
// 표면화된다. (SSH 업로드 경로는 transport.ts 에서 별도로 chmod 755 하므로 무관.)
//
// 여기서 패킹된 .app 안의 해당 파일들에 0o755 를 복원한다. DMG/zip 은 POSIX
// 권한을 보존하므로 이 시점에 고치면 배포본까지 그대로 전달된다.
//
// On Windows it removes the binaries built for the other architecture
// (dropOtherWindowsArch).
const fs = require("node:fs");
const path = require("node:path");
const { Arch } = require("electron-builder");

/** @param {import("electron-builder").AfterPackContext} context */
exports.default = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  if (electronPlatformName === "win32") {
    dropOtherWindowsArch(appOutDir, Arch[context.arch]);
    return;
  }
  if (electronPlatformName !== "darwin") return;

  const appName = packager.appInfo.productFilename;
  const agentDir = path.join(
    appOutDir,
    `${appName}.app`,
    "Contents",
    "Resources",
    "agent",
  );

  if (!fs.existsSync(agentDir)) {
    console.warn(`afterPack: agent dir not found, skipping chmod: ${agentDir}`);
    return;
  }

  /** @type {string[]} */
  const targets = [];

  // 최상위 Go 에이전트 바이너리: agent-<version>-<os>-<arch>
  for (const entry of fs.readdirSync(agentDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith("agent-")) {
      targets.push(path.join(agentDir, entry.name));
    }
  }

  // bin/ 아래 실행 파일(claude 래퍼 등). runtime/·lsp/ 는 tar.gz 라 런타임에
  // 별도 권한으로 풀리므로 대상이 아니다.
  const binDir = path.join(agentDir, "bin");
  if (fs.existsSync(binDir)) {
    for (const entry of fs.readdirSync(binDir, { withFileTypes: true })) {
      if (entry.isFile()) targets.push(path.join(binDir, entry.name));
    }
  }

  for (const file of targets) {
    fs.chmodSync(file, 0o755);
    console.log(`afterPack: chmod 0755 ${path.relative(appOutDir, file)}`);
  }
};

/**
 * Removes the Windows binaries built for the other architecture: the agent
 * and native modules' prebuilds come for both, and the Store
 * takes a package whose files match its architecture (WACK's
 * platform-appropriate files test). The Linux and macOS agents stay, since
 * the app installs them on SSH hosts.
 * @param {string} appOutDir
 * @param {string} arch electron-builder's name for the package's architecture
 */
function dropOtherWindowsArch(appOutDir, arch) {
  const others = arch === "arm64" ? ["x64", "amd64"] : ["arm64"];
  // win32-arm64 (prebuild dirs and .node files), win10-arm64 (node-pty's
  // ConPTY), agent-<version>-windows-arm64.exe.
  const pattern = new RegExp(`^(?:.+-)?(?:win32|win10|windows)-(?:${others.join("|")})(?:\\.node|\\.exe)?$`);
  const resources = path.join(appOutDir, "resources");
  const visit = (dir, recurse) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (pattern.test(entry.name)) {
        fs.rmSync(entryPath, { recursive: true });
        console.log(`afterPack: removed ${path.relative(appOutDir, entryPath)}`);
      } else if (recurse && entry.isDirectory()) {
        visit(entryPath, true);
      }
    }
  };
  visit(path.join(resources, "agent"), false);
  visit(path.join(resources, "app.asar.unpacked"), true);
}
