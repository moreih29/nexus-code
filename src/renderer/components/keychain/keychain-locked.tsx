import { useState } from "react";
import { useTranslation } from "react-i18next";
import { type KeychainItem, keychainLocked } from "../../../shared/keychain";
import { openKeychain, useKeychain } from "../../services/keychain";
import { SettingsRow } from "../settings/section";
import { Button } from "../ui/button";

export function useKeychainLocked(item: KeychainItem): boolean {
  return useKeychain((s) => keychainLocked(s.status, item));
}

export function useKeychainRefused(): boolean {
  return useKeychain((s) => s.status?.refused === true);
}

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

export function KeychainLockedRow({ item }: { item: Exclude<KeychainItem, "profileKeys"> }) {
  return <KeychainLockedRowView item={item} refused={useKeychainRefused()} />;
}

export function KeychainLockedRowView({
  item,
  refused,
}: {
  item: Exclude<KeychainItem, "profileKeys">;
  refused: boolean;
}) {
  const { t } = useTranslation();
  return (
    <SettingsRow
      label={t("common:keychain.locked.title")}
      description={
        refused ? t("common:keychain.locked.refused") : t(`common:keychain.locked.${item}`)
      }
    >
      {refused ? null : <OpenKeychainButton />}
    </SettingsRow>
  );
}
