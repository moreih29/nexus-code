const { statSync } = require("node:fs");

const { NEXUS_MAC_DEVELOPER_ID_IDENTITY: identity, APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
if (!/^[A-F0-9]{40}$/.test(identity ?? "")) {
  throw new Error("NEXUS_MAC_DEVELOPER_ID_IDENTITY must be the Developer ID Application certificate SHA-1");
}
if (!APPLE_API_KEY || !APPLE_API_KEY_ID || !APPLE_API_ISSUER || !statSync(APPLE_API_KEY).isFile()) {
  throw new Error("Developer ID packaging requires an API key file, key ID and issuer ID for notarization");
}
if (process.env.APPLE_ID || process.env.APPLE_APP_SPECIFIC_PASSWORD) {
  throw new Error("Clear Apple ID credentials to use App Store Connect API key notarization");
}

module.exports = {
  extends: "./electron-builder.yml",
  afterPack: "build/after-pack-developer-id.cjs",
  forceCodeSigning: true,
  mac: {
    identity,
    type: "distribution",
    sign: null,
    hardenedRuntime: true,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist",
    preAutoEntitlements: false,
    notarize: true,
    signIgnore: "/NexusCode\\.app/Contents/Resources/",
  },
  dmg: {
    sign: true,
    writeUpdateInfo: false,
  },
};
