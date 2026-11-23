import { useEffect } from "react";
import { startKeychain } from "../../services/keychain";

export function KeychainRoot(): null {
  useEffect(() => startKeychain(), []);
  return null;
}
