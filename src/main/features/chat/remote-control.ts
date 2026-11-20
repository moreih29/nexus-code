import { createLogger } from "../../../shared/log/main";
import type { CliServices } from "../cli/context";
import { output } from "../cli/registry";

const log = createLogger("chat");

/** Recognizes the Claude app command and its alias in a relayed message. */
export function remoteControlCommand(text: string): boolean {
  return /^\/(?:remote-control|rc)(?:\s|$)/i.test(text.trim());
}

/** Applies the explicit state after the caller's workspace or device policy check. */
export async function applyRemoteControl(
  services: CliServices,
  target: { workspaceId: string; tabId: string },
  enabled?: boolean,
): Promise<{ enabled: boolean; url?: string }> {
  const result = await services.ui(
    "chat.remoteControl",
    { ...target, ...(enabled === undefined ? {} : { enabled }) },
    60_000,
  );
  log.info(`Remote Control ${target.tabId.slice(0, 8)} ${result.enabled ? "on" : "off"}`);
  return result;
}

export function remoteControlOutput(
  tab: string,
  target: Record<string, unknown>,
  result: { enabled: boolean; url?: string },
) {
  const { enabled, url } = result;
  return output(
    `Turned Remote Control ${enabled ? "on" : "off"} for ${tab}.${url ? `\n${url}` : ""}`,
    { ...target, ...result },
  );
}
