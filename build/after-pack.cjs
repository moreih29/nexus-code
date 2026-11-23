const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { Arch } = require("electron-builder");

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
  if (electronPlatformName !== "darwin" && electronPlatformName !== "linux") return;

  const agentDir = path.join(resources, "agent");

  if (!fs.existsSync(agentDir)) {
    console.warn(`afterPack: agent dir not found, skipping chmod: ${agentDir}`);
    return;
  }

  const targets = [];

  for (const entry of fs.readdirSync(agentDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith("agent-")) {
      targets.push(path.join(agentDir, entry.name));
    }
  }

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

function dropOtherWindowsArch(appOutDir, arch) {
  const others = arch === "arm64" ? ["x64", "amd64"] : ["arm64"];
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

function remove(target, appDir) {
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`afterPack: removed ${path.relative(appDir, target)}`);
}

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

const VC_RUNTIME = [
  "msvcp140.dll",
  "msvcp140_1.dll",
  "msvcp140_atomic_wait.dll",
  "vcruntime140.dll",
  "vcruntime140_1.dll",
];

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

function checkVoicePrintModel(resources) {
  const dir = path.join(resources, "voice-print");
  const models = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".onnx")) : [];
  if (!models.length) {
    throw new Error(`afterPack: no voice print model in ${dir}; run scripts/voice-print-model.ts first`);
  }
  console.log(`afterPack: voice print model ${models.join(", ")}`);
}
