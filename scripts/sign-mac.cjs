/**
 * electron-builder `mac.sign` hook for releases using the original self-signed
 * certificate. A bridge release embeds a designated requirement that also
 * accepts a Developer ID Application signature from the configured Apple team.
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
 *   NEXUS_MAC_TEAM_ID        optional Apple Team ID for the bridge requirement
 * Without them (local builds) the app stays unsigned, as Electron ships it.
 * The Developer ID path uses electron-builder's default signer instead.
 *
 * Only nested code (frameworks, helper apps) is signed besides the app. The
 * Mach-O files under Resources — the agent binaries, native modules — are
 * sealed as they are: the agent manifest records their sha256.
 */

const { execFileSync, spawnSync } = require("node:child_process");

const appId = 'identifier "com.moreih29.nexus-code"';

function legacyCertificate(identity) {
  if (!/^[a-f0-9]{40}$/i.test(identity ?? "")) {
    throw new Error("NEXUS_MAC_SIGN_IDENTITY must be a certificate SHA-1");
  }
  return `certificate root = H"${identity.toLowerCase()}"`;
}

function developerCertificate(teamId) {
  if (!/^[A-Z0-9]{10}$/.test(teamId ?? "")) {
    throw new Error("NEXUS_MAC_TEAM_ID must be a 10-character Apple Team ID");
  }
  // Apple's Developer ID Application requirement, scoped to our team.
  return (
    "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and " +
    `certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${teamId}"`
  );
}

function bridgeRequirement(identity, teamId) {
  return `${appId} and (${legacyCertificate(identity)} or (${developerCertificate(teamId)}))`;
}

exports.sign = async function sign(configuration) {
  const identity = process.env.NEXUS_MAC_SIGN_IDENTITY;
  if (!identity) {
    console.log("  • skipped macOS code signing  reason=NEXUS_MAC_SIGN_IDENTITY is not set");
    return;
  }
  const keychain = process.env.NEXUS_MAC_SIGN_KEYCHAIN;
  const teamId = process.env.NEXUS_MAC_TEAM_ID;
  const app = configuration.app;
  const requirement = teamId && bridgeRequirement(identity, teamId);
  const args = ["--force", "--sign", identity, ...(keychain ? ["--keychain", keychain] : [])];

  execFileSync("codesign", [...args, "--deep", app], { stdio: "inherit" });
  if (requirement) {
    // --deep would copy the outer app's requirement to its Electron helpers,
    // which have their own identifiers.
    execFileSync("codesign", [...args, `-r=designated => ${requirement}`, app], {
      stdio: "inherit",
    });
  }
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], {
    stdio: "inherit",
  });
  console.log(
    `  • signed macOS app  mode=${requirement ? "bridge" : "self-signed"} identity=${identity}`,
  );
};

function verifyLegacySignature(app) {
  const identity = process.env.NEXUS_MAC_SIGN_IDENTITY;
  const teamId = process.env.NEXUS_MAC_TEAM_ID;
  // Evaluate a separate, legacy-only requirement against the actual signer.
  // Testing for the hash in the bridge's DR alone would also accept its other branch.
  execFileSync(
    "codesign",
    ["--verify", "--strict", `-R=${appId} and ${legacyCertificate(identity)}`, app],
    {
      stdio: "inherit",
    },
  );
  const signature = spawnSync("codesign", ["-dvv", "-r-", app], { encoding: "utf8" });
  if (signature.error) throw signature.error;
  if (
    signature.status !== 0 ||
    !signature.stderr.split("\n").includes("Authority=NexusCode Release Signing")
  ) {
    throw new Error(`Expected NexusCode Release Signing: ${signature.stderr.trim()}`);
  }
  console.log(signature.stdout.trim());
  if (teamId) {
    const requirement = bridgeRequirement(identity, teamId);
    const expected = execFileSync("csreq", [`-r=designated => ${requirement}`, "-t"], {
      encoding: "utf8",
    });
    if (signature.stdout.trim() !== expected.trim())
      throw new Error("Unexpected bridge designated requirement");
  }
}

function verifyDeveloperSignature(app) {
  const requirement = `${appId} and ${developerCertificate(process.env.NEXUS_MAC_TEAM_ID)}`;
  execFileSync("codesign", ["--verify", "--strict", `-R=${requirement}`, app], {
    stdio: "inherit",
  });
  execFileSync("codesign", ["-dvv", "-r-", app], { stdio: "inherit" });
}

if (require.main === module) {
  const [command, app] = process.argv.slice(2);
  if (!app || (command !== "--verify" && command !== "--verify-developer-id")) {
    throw new Error("Usage: node scripts/sign-mac.cjs <--verify|--verify-developer-id> <app>");
  }
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--all-architectures", app], {
    stdio: "inherit",
  });
  if (command === "--verify-developer-id") verifyDeveloperSignature(app);
  else verifyLegacySignature(app);
}
