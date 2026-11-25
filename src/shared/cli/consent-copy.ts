import type { TFunction } from "i18next";
import type { RemoteConsent } from "../../../packages/remote-protocol/src/rpc";
import type { ChatAgent } from "../sessions/task-agent";
import { SETTINGS_ASKING_TO_TURN_ON, settingAskingToTurnOn } from "./settings";

export const CONSENT_AGENT_NAMES: Record<ChatAgent, string> = { claude: "Claude", codex: "Codex" };

type ProfileLayer = Extract<
  NonNullable<RemoteConsent["change"]["instructionEdit"]>["layer"],
  { kind: "profile" }
>;
type ProfileIdentity = Pick<ProfileLayer, "id" | "agent" | "name">;

export function consentProfileLayer(
  { id, agent, name }: ProfileIdentity,
  profiles: readonly ProfileIdentity[],
): ProfileLayer {
  const label = name.trim().toLowerCase();
  const showId = profiles.some(
    (other) =>
      other.id !== id && other.agent === agent && other.name.trim().toLowerCase() === label,
  );
  return { kind: "profile", id, agent, name, ...(showId ? { showId } : {}) };
}

export type ProfileEditLine =
  | {
      field:
        | "name"
        | "color"
        | "address"
        | "preset"
        | "auth"
        | "models"
        | "defaultModel"
        | "lightModel"
        | "context"
        | "reasoning"
        | "label";
      value: string;
    }
  | { field: "connection"; from: ConnectionMethod; to: ConnectionMethod }
  | { field: "key"; change: "replaced" | "removed" };

export interface ProfileEditCopy {
  readonly agent: ChatAgent;
  readonly lines: readonly ProfileEditLine[];
}

type ConnectionMethod = "account" | "api-key" | "custom";

const PROFILE_EDIT_KEYS = {
  name: "agentCli.consent.profile_edit_name",
  color: "agentCli.consent.profile_edit_color",
  address: "agentCli.consent.profile_edit_address",
  preset: "agentCli.consent.profile_edit_preset",
  auth: "agentCli.consent.profile_edit_auth",
  models: "agentCli.consent.profile_edit_models",
  defaultModel: "agentCli.consent.profile_edit_default_model",
  lightModel: "agentCli.consent.profile_edit_light_model",
  context: "agentCli.consent.profile_edit_context",
  reasoning: "agentCli.consent.profile_edit_reasoning",
  label: "agentCli.consent.profile_edit_label",
} as const;

function profileEditLine(t: TFunction<"settings">, agent: ChatAgent, line: ProfileEditLine) {
  switch (line.field) {
    case "connection": {
      const method = (m: ConnectionMethod) => t(`profiles.connection.methods.${m}.${agent}.label`);
      return t("agentCli.consent.profile_add_connection", {
        connection: `${method(line.from)} → ${method(line.to)}`,
      });
    }
    case "key":
      return t(
        line.change === "replaced"
          ? "agentCli.consent.profile_edit_key_replaced"
          : "agentCli.consent.profile_edit_key_removed",
      );
    default:
      return t(PROFILE_EDIT_KEYS[line.field], { value: line.value });
  }
}

export type ConsentChange = RemoteConsent["change"] & {
  readonly profileEdit?: ProfileEditCopy;
};

export function consentDetailsOf(t: TFunction<"settings">, change: ConsentChange) {
  if (change.kind === "settingTurnOn") {
    const asking = settingAskingToTurnOn(change.detail ?? "");
    if (asking) {
      const slug = SETTINGS_ASKING_TO_TURN_ON[asking];
      return {
        detail: t(`agentCli.consent.setting_on.${slug}`),
        body: t(`agentCli.consent.setting_on_body.${slug}`),
      };
    }
  }
  if (change.profileEdit) {
    const { agent, lines } = change.profileEdit;
    return {
      detail: change.detail ?? "",
      body: [
        t("agentCli.consent.profile_add_agent", { agent: CONSENT_AGENT_NAMES[agent] }),
        ...lines.map((line) => profileEditLine(t, agent, line)),
      ].join("\n"),
    };
  }
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
    case "profile": {
      const name = t("agentCli.consent.instructions_profile", {
        agent: CONSENT_AGENT_NAMES[layer.agent],
        name: layer.name,
      });
      detail = layer.showId ? `${name} (${layer.id})` : name;
      break;
    }
    case "workspace":
      detail = layer.name;
      break;
  }
  return { detail, body: clear ? t("agentCli.consent.instructions_clear") : change.body };
}
