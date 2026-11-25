import {
  dismissPermissionPrompt,
  showPermissionPrompt,
} from "../../components/ui/permission-prompt-dialog";
import { ipcListen } from "../../ipc/client";
import { useBrowserPermissionsStore } from "../stores/browser-permissions";

type Unsubscribe = () => void;

let activeUnsubs: Unsubscribe[] = [];

export function initBrowserPermissionSubscriptions(): void {
  for (const unsub of activeUnsubs) {
    unsub();
  }
  activeUnsubs = [];

  activeUnsubs.push(
    ipcListen("browserPermission", "prompt", (payload) => {
      showPermissionPrompt(payload);
    }),
    ipcListen("browserPermission", "dismissed", ({ promptId }) => {
      dismissPermissionPrompt(promptId);
    }),
    ipcListen("browserPermission", "rememberedChanged", () => {
      useBrowserPermissionsStore.getState().rememberedChanged();
    }),
  );
}
