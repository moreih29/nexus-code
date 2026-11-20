import { createLogger } from "../../../shared/log/main";
import type { CliServices } from "../cli/context";

const log = createLogger("chat");

/** Recognizes the Claude app command and its alias in a relayed message. */
export function remoteControlCommand(text: string): boolean {
  return /^\/(?:remote-control|rc)$/i.test(text.trim());
}

/** Applies the explicit state after the caller's workspace or device policy check. */
export async function applyRemoteControl(
  services: CliServices,
  target: { workspaceId: string; tabId: string },
  enabled: boolean,
): Promise<void> {
  await services.ui("chat.remoteControl", { ...target, enabled }, 60_000);
  log.info(`Remote Control ${target.tabId.slice(0, 8)} ${enabled ? "on" : "off"}`);
}
