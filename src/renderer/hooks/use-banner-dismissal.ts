import { useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useNotificationsStore } from "../state/stores/notifications";

export type BannerScope = readonly (string | number | boolean | null | undefined)[];

/**
 * Keep a banner closed across remounts. Use the underlying event ID or version
 * where available. For states that can recur with identical data, pass
 * resetOnChange and keep observing when the state ends (situation undefined).
 */
export function useBannerDismissal(
  scope: BannerScope,
  situation: BannerScope | undefined,
  resetOnChange = false,
) {
  const { t } = useTranslation();
  const key = JSON.stringify(scope);
  const current = situation === undefined ? undefined : JSON.stringify(situation);
  const snapshot = () => useNotificationsStore.getState().dismissedBanners.get(key);
  const closed = useSyncExternalStore(useNotificationsStore.subscribe, snapshot, snapshot);
  useEffect(() => {
    if (resetOnChange && closed !== undefined && closed !== current) {
      useNotificationsStore.getState().resetBannerDismissal(key, closed);
    }
  }, [key, current, closed, resetOnChange]);
  return {
    dismissed: current !== undefined && current === closed,
    dismiss: {
      label: t("action.dismiss"),
      onDismiss: () => {
        if (current !== undefined) useNotificationsStore.getState().dismissBanner(key, current);
      },
    },
  };
}

// Some stores hold the original event object until a new occurrence replaces it.
const eventIds = new WeakMap<object, number>();
let nextEventId = 0;

export function bannerEventId(event: object | null | undefined): number | undefined {
  if (!event) return undefined;
  const known = eventIds.get(event);
  if (known !== undefined) return known;
  const id = ++nextEventId;
  eventIds.set(event, id);
  return id;
}
