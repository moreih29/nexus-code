import type { TFunction } from "i18next";
import type { RemoteConsent } from "../../../packages/remote-protocol/src/rpc";
import type { BehaviorValue } from "../agent-profiles/behavior";
import type { LspPathLanguage } from "../lsp/settings";
import type { ChatAgent } from "../sessions/task-agent";
import { SETTINGS_ASKING_TO_TURN_ON, settingAskingToTurnOn } from "./settings";

export const CONSENT_AGENT_NAMES: Record<ChatAgent, string> = { claude: "Claude", codex: "Codex" };

export function consentAllowScopes(
  kind: string,
  eachTime: boolean | undefined,
  crossWorkspace: boolean,
): NonNullable<RemoteConsent["allowScopes"]> {
  if (eachTime) return { once: "once" };
  return {
    once: "once",
    session: crossWorkspace && kind !== "sandboxExecution" ? "chat-session" : "until-restart",
  };
}

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
  | { field: "key"; change: "replaced" | "removed" }
  | { field: "shared"; value: string }
  | { field: "sharedCopy"; file: string }
  | { field: "sharedUnlinked"; files: string }
  | { field: "env" | "header" | "query"; name: string; change: "added" | "changed" | "removed" }
  | { field: "advanced"; setting: AdvancedSetting; value: string }
  | { field: "advanced"; setting: "experimentalHeaders"; from: boolean; to: boolean }
  | {
      field: "behavior";
      id: string;
      from: BehaviorValue | null;
      to: BehaviorValue | null;
      wider?: boolean;
    }
  | { field: "behaviorShared"; file: string };

export type AdvancedSetting = "timeout" | "outputTokens" | "retries" | "streamTimeout";

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

function onOff(t: TFunction<"settings">, value: boolean): string {
  return t(value ? "agentCli.consent.profile_edit_on" : "agentCli.consent.profile_edit_off");
}

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
    case "shared":
      return t("agentCli.consent.profile_edit_shared", { value: line.value });
    case "sharedCopy":
      return t("agentCli.consent.profile_edit_shared_copy", { file: line.file });
    case "sharedUnlinked":
      return t("agentCli.consent.profile_edit_shared_unlinked", { files: line.files });
    case "env":
    case "header":
    case "query":
      return t(`agentCli.consent.profile_edit_${line.field}`, {
        name: line.name,
        change: t(`agentCli.consent.profile_edit_value_${line.change}`),
      });
    case "advanced":
      if (line.setting === "experimentalHeaders") {
        return t("agentCli.consent.profile_edit_setting", {
          setting: t("agentCli.consent.profile_edit_experimental_headers"),
          value: `${onOff(t, line.from)} → ${onOff(t, line.to)}`,
        });
      }
      return t("agentCli.consent.profile_edit_setting", {
        setting: t(`profiles.connection.${line.setting}`),
        value: line.value,
      });
    case "behavior": {
      const shown = (value: BehaviorValue | null) =>
        value === null
          ? t("profiles.behavior.default")
          : typeof value === "boolean"
            ? onOff(t, value)
            : String(value);
      const text = t("agentCli.consent.profile_edit_setting", {
        setting: t(`profiles.behavior.fields.${line.id}.label`, { defaultValue: line.id }),
        value: `${shown(line.from)} → ${shown(line.to)}`,
      });
      return line.wider ? `${text} · ${t("agentCli.consent.profile_edit_wider")}` : text;
    }
    case "behaviorShared":
      return t("agentCli.consent.profile_edit_behavior_shared", { file: line.file });
    default:
      return t(PROFILE_EDIT_KEYS[line.field], { value: line.value });
  }
}

export interface ProfileRemoveCopy {
  readonly agent: ChatAgent;
  readonly folder: string;
}

export type SettingsEditLine =
  | {
      readonly field: "name" | "program" | "args" | "path" | "location";
      readonly from?: string;
      readonly to: string;
    }
  | { readonly field: "defaultShell"; readonly from: string }
  | { readonly field: "notes"; readonly count: number; readonly size: string }
  | { readonly field: "workspaces"; readonly count: number };

export interface SettingsEditCopy {
  readonly language?: LspPathLanguage;
  readonly lines: readonly SettingsEditLine[];
}

const SETTINGS_EDIT_KEYS = {
  name: "agentCli.consent.edit_name",
  program: "agentCli.consent.edit_program",
  args: "agentCli.consent.edit_args",
  path: "agentCli.consent.edit_path",
  location: "agentCli.consent.edit_location",
} as const;

function settingsEditValue(t: TFunction<"settings">, field: string, value: string): string {
  if (value !== "") return value;
  return t(field === "path" ? "agentCli.consent.edit_path_default" : "agentCli.consent.edit_none");
}

function settingsEditLine(t: TFunction<"settings">, line: SettingsEditLine): string {
  switch (line.field) {
    case "defaultShell":
      return t("agentCli.consent.edit_default_shell", {
        value: `${line.from} → ${t("terminal.shell.systemPlain")}`,
      });
    case "notes":
      return t("agentCli.consent.edit_notes_trash", { count: line.count, size: line.size });
    case "workspaces":
      return t("agentCli.consent.edit_workspaces", { count: line.count });
    default: {
      const to = settingsEditValue(t, line.field, line.to);
      const from =
        line.from === undefined ? undefined : settingsEditValue(t, line.field, line.from);
      return t(SETTINGS_EDIT_KEYS[line.field], {
        value: from === undefined ? to : `${from} → ${to}`,
      });
    }
  }
}

export interface ProfileDefaultCopy {
  readonly agent: ChatAgent;
  readonly from: string;
  readonly to: string;
}

export interface ProfileRuleCopy {
  readonly target: { readonly kind: "folder" | "ssh" | "workspace"; readonly name: string };
  readonly lines: readonly {
    readonly agent: ChatAgent;
    readonly from?: string | null;
    readonly to?: string | null;
  }[];
  readonly removed?: boolean;
  readonly applies: number;
  readonly others?: number;
}

export type ConsentChange = RemoteConsent["change"] & {
  readonly profileEdit?: ProfileEditCopy;
  readonly profileRemove?: ProfileRemoveCopy;
  readonly settingsEdit?: SettingsEditCopy;
  readonly profileDefault?: ProfileDefaultCopy;
  readonly profileRule?: ProfileRuleCopy;
};

function profileRuleBody(t: TFunction<"settings">, rule: ProfileRuleCopy): string {
  const choice = (id: string | null | undefined) =>
    id === null || id === undefined ? t("profileRules.inherit") : id;
  const lines = rule.lines.map(({ agent, from, to }) =>
    t("agentCli.consent.profile_rule_agent", {
      agent: CONSENT_AGENT_NAMES[agent],
      value: rule.removed
        ? choice(from)
        : from === undefined
          ? choice(to)
          : `${choice(from)} → ${choice(to)}`,
    }),
  );
  return [
    t(`agentCli.consent.profile_rule_${rule.target.kind}`, { name: rule.target.name }),
    ...lines,
    ...(rule.removed ? [t("agentCli.consent.profile_rule_removed")] : []),
    t("agentCli.consent.profile_rule_applies", { count: rule.applies }),
    ...(rule.others ? [t("agentCli.consent.profile_rule_others", { count: rule.others })] : []),
  ].join("\n");
}

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
  if (change.settingsEdit) {
    const { language, lines } = change.settingsEdit;
    return {
      detail: language
        ? t("languageServers.serverPath", { language: t(`languageServers.language.${language}`) })
        : (change.detail ?? ""),
      body: lines.map((line) => settingsEditLine(t, line)).join("\n"),
    };
  }
  if (change.profileDefault) {
    const { agent, from, to } = change.profileDefault;
    return {
      detail: change.detail ?? "",
      body: [
        t("agentCli.consent.profile_add_agent", { agent: CONSENT_AGENT_NAMES[agent] }),
        t("agentCli.consent.profile_default_value", { value: `${from} → ${to}` }),
      ].join("\n"),
    };
  }
  if (change.profileRule) {
    return { detail: change.detail ?? "", body: profileRuleBody(t, change.profileRule) };
  }
  if (change.profileRemove) {
    const { agent, folder } = change.profileRemove;
    return {
      detail: change.detail ?? "",
      body: [
        t("agentCli.consent.profile_add_agent", { agent: CONSENT_AGENT_NAMES[agent] }),
        t("profiles.removeConfirm.description", { dir: folder }),
      ].join("\n"),
    };
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
