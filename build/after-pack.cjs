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
//
// On every platform it keeps the ONNX Runtime the platform runs, which the
// voice print model needs, and checks the model is in the package
// (keepOwnOnnxRuntime, checkVoicePrintModel).
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { Arch } = require("electron-builder");

/** @param {import("electron-builder").AfterPackContext} context */
exports.default = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  const arch = Arch[context.arch];
  const appName = packager.appInfo.productFilename;
  const resources =
    electronPlatformName === "darwin"
      ? path.join(appOutDir, `${appName}.app`, "Contents", "Resources")
      : path.join(appOutDir, "resources");
  keepOwnOnnxRuntime(resources, electronPlatformName, arch);
  checkVoicePrintModel(resources);
  if (electronPlatformName === "win32") {
    dropOtherWindowsArch(appOutDir, arch);
    return;
  }
  if (electronPlatformName !== "darwin") return;

  const agentDir = path.join(resources, "agent");

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

/** @param {string} target @param {string} appDir */
function remove(target, appDir) {
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`afterPack: removed ${path.relative(appDir, target)}`);
}

/**
 * Keeps only the platform's own ONNX Runtime of the ones onnxruntime-node
 * comes with (bin/napi-v6/<platform>/<arch>), which are most of its size.
 * Of those it also drops DirectML and its shader compiler on Windows, which
 * ONNX Runtime loads only to run a model on the GPU (DirectML.dll is a
 * delay-loaded import) while the voice print model runs on the CPU, and the
 * versioned copy of the macOS library, as the binding loads
 * libonnxruntime.1.dylib. On Windows it adds the Visual C++ runtime the
 * library links against (addVcRuntime).
 * @param {string} resources
 * @param {string} platform
 * @param {string} arch
 */
function keepOwnOnnxRuntime(resources, platform, arch) {
  const bin = path.join(resources, "app.asar.unpacked", "node_modules", "onnxruntime-node", "bin", "napi-v6");
  const own = path.join(bin, platform, arch);
  if (!fs.existsSync(path.join(own, "onnxruntime_binding.node"))) {
    throw new Error(`afterPack: ONNX Runtime for ${platform}-${arch} not found in ${bin}`);
  }
  for (const p of fs.readdirSync(bin)) {
    if (p !== platform) {
      remove(path.join(bin, p), resources);
      continue;
    }
    for (const a of fs.readdirSync(path.join(bin, p))) {
      if (a !== arch) remove(path.join(bin, p, a), resources);
    }
  }
  for (const name of fs.readdirSync(own)) {
    if (/^(?:DirectML|dxcompiler)\.dll$/i.test(name) || /^libonnxruntime\.\d+\.\d+\.\d+\.dylib$/.test(name)) {
      remove(path.join(own, name), resources);
    }
  }
  if (platform === "win32") addVcRuntime(own, arch);
}

/** The Visual C++ runtime's libraries that ONNX Runtime and its binding link against. */
const VC_RUNTIME = [
  "msvcp140.dll",
  "msvcp140_1.dll",
  "msvcp140_atomic_wait.dll",
  "vcruntime140.dll",
  "vcruntime140_1.dll",
];

/**
 * Copies the Visual C++ runtime next to ONNX Runtime, which Windows finds
 * there when the binding loads (Node loads an addon with its own folder
 * searched first): Windows does not come with it, and only some machines
 * have it installed. Taken from Visual Studio's redistributable files
 * (VC\Redist\MSVC, the newest), or from the build machine's System32 when
 * it has no Visual Studio.
 * @param {string} dir
 * @param {string} arch
 */
function addVcRuntime(dir, arch) {
  const places = [];
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (fs.existsSync(vswhere)) {
    const installs = execFileSync(vswhere, ["-products", "*", "-property", "installationPath"], { encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean);
    const newest = (a, b) => b.localeCompare(a, undefined, { numeric: true });
    for (const install of installs) {
      const redist = path.join(install, "VC", "Redist", "MSVC");
      if (!fs.existsSync(redist)) continue;
      for (const version of fs.readdirSync(redist).filter((v) => /^\d/.test(v)).sort(newest)) {
        const archDir = path.join(redist, version, arch);
        if (!fs.existsSync(archDir)) continue;
        for (const crt of fs.readdirSync(archDir).filter((n) => /^Microsoft\.VC\d+\.CRT$/.test(n)).sort(newest)) {
          places.push(path.join(archDir, crt));
        }
      }
    }
  }
  if (process.arch === arch) places.push(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"));
  const from = places.find((place) => VC_RUNTIME.every((name) => fs.existsSync(path.join(place, name))));
  if (!from) {
    throw new Error(`afterPack: no Visual C++ runtime (${VC_RUNTIME.join(", ")}) for ${arch} in ${places.join("; ")}`);
  }
  for (const name of VC_RUNTIME) fs.copyFileSync(path.join(from, name), path.join(dir, name));
  console.log(`afterPack: Visual C++ runtime from ${from}`);
}

/**
 * Fails the build when the package has no voice print model: on Windows and
 * Linux it is fetched for the build (scripts/voice-print-model.ts).
 * @param {string} resources
 */
function checkVoicePrintModel(resources) {
  const dir = path.join(resources, "voice-print");
  const models = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".onnx")) : [];
  if (!models.length) {
    throw new Error(`afterPack: no voice print model in ${dir}; run scripts/voice-print-model.ts first`);
  }
  console.log(`afterPack: voice print model ${models.join(", ")}`);
}
