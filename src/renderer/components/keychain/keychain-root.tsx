// Mounted once: follows the macOS keychain for this window, asking before it
// is read and saying what to choose while macOS asks (services/keychain).

import { useEffect } from "react";
import { startKeychain } from "../../services/keychain";

export function KeychainRoot(): null {
  useEffect(() => startKeychain(), []);
  return null;
}
