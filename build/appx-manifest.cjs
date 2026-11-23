const fs = require("node:fs");
const path = require("node:path");

const AGENT_ALIAS = "nexuscode-agent.exe";

exports.default = async function appxManifestCreated(manifestPath) {
  let manifest = fs.readFileSync(manifestPath, "utf8");
  const arch = /ProcessorArchitecture="([^"]*)"/.exec(manifest)?.[1];
  if (!arch) throw new Error(`appx-manifest: no ProcessorArchitecture in ${manifestPath}`);
  const agent = agentExecutable(arch === "x64" ? "amd64" : arch);
  if (manifest.includes("<Extensions>")) {
    throw new Error(`appx-manifest: ${manifestPath} already has Extensions`);
  }

  manifest = manifest.replace(
    "<Package",
    '<Package\n   xmlns:uap3="http://schemas.microsoft.com/appx/manifest/uap/windows10/3"',
  );
  manifest = manifest.replace(
    /\s*<\/Application>/,
    `
      <Extensions>
        <uap3:Extension Category="windows.appExecutionAlias" Executable="app\\resources\\agent\\${agent}" EntryPoint="Windows.FullTrustApplication">
          <uap3:AppExecutionAlias>
            <desktop:ExecutionAlias Alias="${AGENT_ALIAS}" />
          </uap3:AppExecutionAlias>
        </uap3:Extension>
      </Extensions>
    </Application>`,
  );
  fs.writeFileSync(manifestPath, manifest);
};

function agentExecutable(arch) {
  const manifestPath = path.join(__dirname, "..", "dist", "agent", "manifest.json");
  const { binaries } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const binary = binaries.find((it) => it.os === "windows" && it.arch === arch);
  if (!binary) throw new Error(`appx-manifest: no windows-${arch} agent in ${manifestPath}`);
  return binary.path;
}
