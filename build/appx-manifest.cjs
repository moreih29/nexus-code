// electron-builder appxManifestCreated hook: gives the app and its agent App
// Execution Aliases in the MSIX package.
//
// A package's files run only in a process with the package's identity. Git,
// which the agent starts from outside the package and which so has none, in
// turn starts the agent as its askpass helper (internal/git) and the app as
// its editor (src/main/features/git/domain/helpers/launcher.ts). It can start
// them only through an alias, which hands the program the identity. An
// application takes one alias, so the agent gets an application of its own,
// left off the Start menu.
const fs = require("node:fs");
const path = require("node:path");

const APP_ALIAS = "nexuscode.exe";
const AGENT_ALIAS = "nexuscode-agent.exe";

/** @param {string} manifestPath */
exports.default = async function appxManifestCreated(manifestPath) {
  let manifest = fs.readFileSync(manifestPath, "utf8");
  const attribute = (name) => {
    const match = new RegExp(`${name}="([^"]*)"`).exec(manifest);
    if (!match) throw new Error(`appx-manifest: no ${name} in ${manifestPath}`);
    return match[1];
  };
  const arch = attribute("ProcessorArchitecture");
  const agent = agentExecutable(arch === "x64" ? "amd64" : arch);
  // electron-builder writes Extensions for protocols and file associations,
  // which the app does not declare; the app's alias would need to join them.
  if (manifest.includes("<Extensions>")) {
    throw new Error(`appx-manifest: ${manifestPath} already has Extensions`);
  }

  manifest = manifest.replace(
    "<Package",
    '<Package\n   xmlns:uap3="http://schemas.microsoft.com/appx/manifest/uap/windows10/3"',
  );
  manifest = manifest.replace(
    /\s*<\/Application>/,
    `\n      ${extensions(APP_ALIAS)}\n    </Application>
    <Application Id="Agent" Executable="app\\resources\\agent\\${agent}" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
       AppListEntry="none"
       BackgroundColor="${attribute("BackgroundColor")}"
       DisplayName="${attribute("DisplayName")} agent"
       Square150x150Logo="${attribute("Square150x150Logo")}"
       Square44x44Logo="${attribute("Square44x44Logo")}"
       Description="${attribute("DisplayName")} agent" />
      ${extensions(AGENT_ALIAS)}
    </Application>`,
  );
  fs.writeFileSync(manifestPath, manifest);
};

/** @param {string} alias */
function extensions(alias) {
  return `<Extensions>
        <uap3:Extension Category="windows.appExecutionAlias">
          <uap3:AppExecutionAlias>
            <desktop:ExecutionAlias Alias="${alias}" />
          </uap3:AppExecutionAlias>
        </uap3:Extension>
      </Extensions>`;
}

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
