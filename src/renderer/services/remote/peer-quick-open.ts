import { createListenerBus } from "../../../shared/util/listener-bus";

const requests = createListenerBus<string>();

export const requestPeerQuickOpen = requests.notify;
export const subscribePeerQuickOpen = requests.subscribe;
