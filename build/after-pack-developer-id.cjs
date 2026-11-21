const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { default: afterPack } = require("./after-pack.cjs");

const machOMagic = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca,
]);

function isMachO(file) {
  const header = Buffer.alloc(4);
  const fd = fs.openSync(file, "r");
  try {
    if (fs.readSync(fd, header, 0, 4, 0) !== 4 || !machOMagic.has(header.readUInt32BE())) return false;
  } finally {
    fs.closeSync(fd);
  }
  // Universal Mach-O and Java classes can have the same magic.
  return execFileSync("/usr/bin/file", ["-b", file], { encoding: "utf8" }).startsWith("Mach-O ");
}

/** @param {import("electron-builder").AfterPackContext} context */
exports.default = async function afterPackDeveloperId(context) {
  await afterPack(context);
  const { appOutDir, packager, electronPlatformName } = context;
  if (electronPlatformName !== "darwin") throw new Error("Developer ID packaging requires macOS");

  const resources = path.join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources");
  const keychain = process.env.CSC_KEYCHAIN;
  const args = [
    "--force",
    "--sign",
    packager.platformSpecificBuildOptions.identity,
    "--options",
    "runtime",
    "--timestamp",
    ...(keychain ? ["--keychain", keychain] : []),
  ];
  const signed = new Set();
  for (const entry of fs.readdirSync(resources, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    if (!isMachO(file)) continue;
    // Go agents and node-pty's spawn helper need no runtime exceptions.
    // The native modules and dylibs share the Electron app's signing team.
    execFileSync("codesign", [...args, file], { stdio: "inherit" });
    execFileSync("codesign", ["--verify", "--strict", "--all-architectures", file], { stdio: "inherit" });
    signed.add(file);
    console.log(`afterPack: signed ${path.relative(resources, file)}`);
  }

  const agentDir = path.join(resources, "agent");
  const manifestPath = path.join(agentDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const agent of manifest.binaries) {
    if (agent.os !== "darwin") continue;
    const file = path.join(agentDir, agent.path);
    if (!signed.has(file)) throw new Error(`Missing Mach-O agent at ${file}`);
    // SSH bootstrap checks the local upload and the installed bytes against
    // this digest. Update the packaged copy before signing seals Resources.
    const bytes = fs.readFileSync(file);
    agent.sha256 = createHash("sha256").update(bytes).digest("hex");
    agent.size = bytes.length;
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
};
