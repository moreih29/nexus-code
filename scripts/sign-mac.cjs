/**
 * electron-builder `mac.sign` hook — signs the packaged app with the release
 * certificate.
 *
 * The certificate is self-signed (no Apple Developer ID), which macOS does not
 * trust, so electron-builder's own signing never finds it as an identity; this
 * hook signs with it by hash instead. One unchanging certificate is what lets
 * an installed app update itself: Squirrel.Mac installs an update only when
 * its signature meets the running app's designated requirement, which names
 * this certificate (see src/main/features/updates/installer.ts).
 *
 * The release workflow imports the certificate into a keychain and sets:
 *   NEXUS_MAC_SIGN_IDENTITY  SHA-1 of the certificate
 *   NEXUS_MAC_SIGN_KEYCHAIN  that keychain
 * Without them (local builds) the app stays unsigned, as Electron ships it.
 *
 * Only nested code (frameworks, helper apps) is signed besides the app. The
 * Mach-O files under Resources — the agent binaries, native modules — are
 * sealed as they are: the agent manifest records their sha256.
 */

const { execFileSync } = require("node:child_process");

exports.sign = async function sign(configuration) {
  const identity = process.env.NEXUS_MAC_SIGN_IDENTITY;
  if (!identity) {
    console.log("  • skipped macOS code signing  reason=NEXUS_MAC_SIGN_IDENTITY is not set");
    return;
  }
  const keychain = process.env.NEXUS_MAC_SIGN_KEYCHAIN;
  const app = configuration.app;

  execFileSync(
    "codesign",
    ["--force", "--deep", "--sign", identity, ...(keychain ? ["--keychain", keychain] : []), app],
    { stdio: "inherit" },
  );
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], {
    stdio: "inherit",
  });
  console.log(`  • signed  app=${app} identity=${identity}`);
};
