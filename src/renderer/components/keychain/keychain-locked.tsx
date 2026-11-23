// What a setting kept in the macOS keychain shows while the keychain is not
// open: locked, and a button that opens it (macOS may then ask).

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { type KeychainItem, keychainLocked } from "../../../shared/keychain";
import { openKeychain, useKeychain } from "../../services/keychain";
import { SettingsRow } from "../settings/section";
import { Button } from "../ui/button";

/** Whether the item waits on the keychain now. */
export function useKeychainLocked(item: KeychainItem): boolean {
  return useKeychain((s) => keychainLocked(s.status, item));
}

/** The keychain's "열기", busy while it opens. */
export function OpenKeychainButton({ className }: { className?: string }) {
  const { t } = useTranslation();
  const opening = useKeychain((s) => s.status?.state === "opening");
  const [pressed, setPressed] = useState(false);
  const open = () => {
    setPressed(true);
    void openKeychain()
      .catch(() => {})
      .finally(() => setPressed(false));
  };
  return (
    <Button
      variant="outline"
      size="sm"
      className={className}
      disabled={opening || pressed}
      onClick={open}
    >
      {t("common:keychain.locked.open")}
    </Button>
  );
}

/** A settings row: "키체인 잠김", what waits, and the button. */
export function KeychainLockedRow({ item }: { item: Exclude<KeychainItem, "profileKeys"> }) {
  const { t } = useTranslation();
  return (
    <SettingsRow
      label={t("common:keychain.locked.title")}
      description={t(`common:keychain.locked.${item}`)}
    >
      <OpenKeychainButton />
    </SettingsRow>
  );
}
