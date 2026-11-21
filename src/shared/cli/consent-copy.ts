import type { TFunction } from "i18next";
import type { RemoteConsent } from "../../../packages/remote-protocol/src/rpc";
import type { ChatAgent } from "../sessions/task-agent";

export const CONSENT_AGENT_NAMES: Record<ChatAgent, string> = { claude: "Claude", codex: "Codex" };

export function consentDetailsOf(t: TFunction<"settings">, change: RemoteConsent["change"]) {
  if (change.profileAdd) {
    const { agent, folder, connection, endpoint } = change.profileAdd;
    const method = t(`profiles.connection.methods.${connection}.${agent}.label`);
    return {
      detail: change.detail ?? "",
      body: [
        t("agentCli.consent.profile_add_agent", { agent: CONSENT_AGENT_NAMES[agent] }),
        t("agentCli.consent.profile_add_folder", { folder }),
        t("agentCli.consent.profile_add_connection", {
          connection: endpoint ? `${method} · ${endpoint}` : method,
        }),
      ].join("\n"),
    };
  }
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
