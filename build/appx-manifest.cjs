// electron-builder appxManifestCreated hook: gives the agent an App
// Execution Alias in the MSIX package.
//
// A package's files run only in a process with the package's identity. Git,
// which the agent starts from outside the package and which so has none, in
// turn starts the agent as its askpass helper (internal/git) and the app as
// its editor (src/main/features/git/domain/helpers/launcher.ts). It can start
// them only through an alias, which hands the program the identity. The Store
// takes a package of one application, which takes one alias; the alias names
// the agent, which starts the app for git through `package-run`.
const fs = require("node:fs");
const path = require("node:path");

const AGENT_ALIAS = "nexuscode-agent.exe";

/** @param {string} manifestPath */
exports.default = async function appxManifestCreated(manifestPath) {
  let manifest = fs.readFileSync(manifestPath, "utf8");
  const arch = /ProcessorArchitecture="([^"]*)"/.exec(manifest)?.[1];
  if (!arch) throw new Error(`appx-manifest: no ProcessorArchitecture in ${manifestPath}`);
  const agent = agentExecutable(arch === "x64" ? "amd64" : arch);
  // electron-builder writes Extensions for protocols and file associations,
  // which the app does not declare; the alias would need to join them.
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

/**
 * The file name of the Windows agent for arch, from the agent build's
 * manifest (scripts/build-agent.ts), which the package carries as
 * resources/agent.
 * @param {string} arch
 */
function agentExecutable(arch) {
  const manifestPath = path.join(__dirname, "..", "dist", "agent", "manifest.json");
  const { binaries } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const binary = binaries.find((it) => it.os === "windows" && it.arch === arch);
  if (!binary) throw new Error(`appx-manifest: no windows-${arch} agent in ${manifestPath}`);
  return binary.path;
}
