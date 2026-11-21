import type { TFunction } from "i18next";
import type { RemoteConsent } from "../../../packages/remote-protocol/src/rpc";
import type { ChatAgent } from "../sessions/task-agent";

export const CONSENT_AGENT_NAMES: Record<ChatAgent, string> = { claude: "Claude", codex: "Codex" };

export function consentDetailsOf(t: TFunction<"settings">, change: RemoteConsent["change"]) {
  if (!change.instructionEdit) return { detail: change.detail ?? "", body: change.body };
  const { layer, clear } = change.instructionEdit;
  let detail: string;
  switch (layer.kind) {
    case "all":
      detail = t("instructions.all");
      break;
    case "agent":
      detail = CONSENT_AGENT_NAMES[layer.agent];
      break;
    case "profile":
      detail = t("agentCli.consent.instructions_profile", {
        agent: CONSENT_AGENT_NAMES[layer.agent],
        name: layer.name,
        id: layer.id,
      });
      break;
    case "workspace":
      detail = layer.name;
      break;
  }
  return { detail, body: clear ? t("agentCli.consent.instructions_clear") : change.body };
}
