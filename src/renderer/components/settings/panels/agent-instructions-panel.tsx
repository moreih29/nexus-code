import { ChevronRight } from "lucide-react";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type AgentProfile,
  PROFILE_AGENTS,
  profilesOf,
} from "../../../../shared/agent-profiles/profiles";
import {
  type InstructionEdit,
  type InstructionScope,
  InstructionTextSchema,
  instructionText,
  mergeAgentInstructions,
  withInstruction,
} from "../../../../shared/chat/instructions";
import type { ChatAgent } from "../../../../shared/sessions/task-agent";
import {
  saveInstructionEdits,
  useAgentInstructionsStore,
} from "../../../state/stores/agent-instructions";
import { useAgentProfilesStore } from "../../../state/stores/agent-profiles";
import { useSettingsUIStore } from "../../../state/stores/settings-ui";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { cn } from "../../../utils/cn";
import { ProfileDot, profileName } from "../../agent-profiles/profile-badge";
import { Button } from "../../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { InstructionField, InstructionPreview } from "../instruction-field";

const agentNames = { claude: "Claude", codex: "Codex" } as const;
const all: InstructionScope = { kind: "all" };

function scopeKey(scope: InstructionScope): string {
  switch (scope.kind) {
    case "all":
      return "all";
    case "agent":
      return scope.agent;
    default:
      return `${scope.kind}:${scope.id}`;
  }
}

export function AgentInstructionsPanel() {
  const { t } = useTranslation(["settings", "common"]);
  const config = useAgentInstructionsStore((state) => state.config);
  const profiles = useAgentProfilesStore((state) => state.config);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const initialScope = useSettingsUIStore((state) => state.initialInstructionScope);
  const [selected, setSelected] = useState(initialScope ?? all);
  const [drafts, setDrafts] = useState<Record<string, InstructionEdit>>({});
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [agent, setAgent] = useState<ChatAgent>(() => {
    if (initialScope?.kind === "agent") return initialScope.agent;
    if (initialScope?.kind === "profile") {
      return (
        PROFILE_AGENTS.find((kind) =>
          profilesOf(profiles, kind).some(({ id }) => id === initialScope.id),
        ) ?? "claude"
      );
    }
    return "claude";
  });
  const [profileId, setProfileId] = useState(
    initialScope?.kind === "profile" ? initialScope.id : "",
  );
  const [workspaceId, setWorkspaceId] = useState(
    initialScope?.kind === "workspace" ? initialScope.id : "",
  );
  const previewProfiles = profilesOf(profiles, agent);
  const previewProfile = previewProfiles.find(({ id }) => id === profileId) ?? previewProfiles[0];
  const previewWorkspace = workspaces.find(({ id }) => id === workspaceId) ?? workspaces[0];
  const selectedWorkspace =
    selected.kind === "workspace" ? workspaces.find(({ id }) => id === selected.id) : undefined;
  const selectedProfile =
    selected.kind === "profile"
      ? PROFILE_AGENTS.flatMap((kind) => profilesOf(profiles, kind)).find(
          ({ id }) => id === selected.id,
        )
      : undefined;
  const scope =
    (selected.kind === "profile" && !selectedProfile) ||
    (selected.kind === "workspace" && !selectedWorkspace)
      ? all
      : selected;
  const label = selectedProfile
    ? profileName(selectedProfile, t)
    : (selectedWorkspace?.name ??
      (scope.kind === "agent" ? agentNames[scope.agent] : t("instructions.all")));
  const hint =
    scope.kind === "agent"
      ? t(`instructions.scope.${scope.agent}`)
      : t(`instructions.scope.${scope.kind}`);
  const edits = Object.values(drafts).filter(
    (edit) => edit.text !== instructionText(config, edit.scope),
  );
  const preview = mergeAgentInstructions(edits.reduce(withInstruction, config), {
    agent,
    profile: previewProfile,
    workspace: previewWorkspace,
  });
  const key = scopeKey(scope);
  const text = drafts[key]?.text ?? instructionText(config, scope);

  const select = (next: InstructionScope, profile?: AgentProfile) => {
    setSelected(next);
    if (profile) {
      setAgent(profile.agent);
      setProfileId(profile.id);
    } else if (next.kind === "agent") {
      setAgent(next.agent);
    } else if (next.kind === "workspace") {
      setWorkspaceId(next.id);
    }
  };
  const row = (next: InstructionScope, title: string, profile?: AgentProfile) => {
    const id = scopeKey(next);
    const active = id === key;
    const hasText = (drafts[id]?.text ?? instructionText(config, next)).trim() !== "";
    return (
      <button
        key={id}
        type="button"
        aria-pressed={active}
        title={title}
        onClick={() => select(next, profile)}
        className={cn(
          "flex w-full min-w-0 items-center gap-1.5 rounded-(--radius-control) px-2 py-1.5 text-left text-app-ui-sm hover:bg-[var(--state-hover-bg)]",
          profile && "pl-4",
          active && "bg-[var(--sidebar-item-selected-bg)] text-[var(--sidebar-item-selected-fg)]",
        )}
      >
        {profile && <ProfileDot color={profile.color} className="size-1.5" />}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {hasText && (
          <span
            className="size-1.5 shrink-0 rounded-full bg-[var(--state-success-fg)]"
            aria-label={t("instructions.hasText")}
            role="img"
          />
        )}
      </button>
    );
  };
  const save = async () => {
    setSaving(true);
    setFailed(false);
    try {
      await saveInstructionEdits(edits);
      setDrafts({});
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div data-testid="agent-instructions-panel" className="flex flex-col gap-3">
      <p className="text-app-ui-sm text-muted-foreground">{t("instructions.description")}</p>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2.4fr)] gap-3 border-y border-border py-3">
        <div className="min-w-0 border-r border-border pr-2">
          {row(all, t("instructions.all"))}
          <h3 className="mt-3 px-2 text-app-ui-sm text-muted-foreground">
            {t("instructions.agentsAndProfiles")}
          </h3>
          {PROFILE_AGENTS.map((kind) => (
            <Fragment key={kind}>
              {row({ kind: "agent", agent: kind }, agentNames[kind])}
              {profilesOf(profiles, kind).map((profile) =>
                row({ kind: "profile", id: profile.id }, profileName(profile, t), profile),
              )}
            </Fragment>
          ))}
          <h3 className="mt-3 px-2 text-app-ui-sm text-muted-foreground">
            {t("instructions.workspaces")}
          </h3>
          {workspaces.map((workspace) =>
            row({ kind: "workspace", id: workspace.id }, workspace.name),
          )}
          <div className="mt-3 flex flex-col gap-1 border-t border-border px-2 pt-2 text-app-ui-sm text-muted-foreground">
            <p className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="size-1.5 shrink-0 rounded-full bg-[var(--state-success-fg)]"
              />
              {t("instructions.hasText")}
            </p>
            <p>{t("instructions.sessionHint")}</p>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <div>
            <h3 className="text-app-body font-semibold">{label}</h3>
            <p className="text-app-ui-sm text-muted-foreground">{hint}</p>
          </div>
          <InstructionField
            label={label}
            text={text}
            rows={5}
            onChange={(text) => setDrafts((drafts) => ({ ...drafts, [key]: { scope, text } }))}
          />
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-app-body">
              <ChevronRight aria-hidden className="size-3 group-open:rotate-90" />
              {t("instructions.preview")}
            </summary>
            <div className="mt-2 flex min-w-0 gap-1.5">
              <Select value={agent} onValueChange={(value) => setAgent(value as ChatAgent)}>
                <SelectTrigger
                  className="min-w-0 [&>span]:truncate"
                  ariaLabel={t("instructions.agent")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROFILE_AGENTS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {agentNames[kind]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={previewProfile?.id} onValueChange={setProfileId}>
                <SelectTrigger
                  className="min-w-0 [&>span]:truncate"
                  ariaLabel={t("instructions.profile")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {previewProfiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profileName(profile, t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={previewWorkspace?.id}
                onValueChange={setWorkspaceId}
                disabled={!workspaces.length}
              >
                <SelectTrigger
                  className="min-w-0 [&>span]:truncate"
                  ariaLabel={t("instructions.workspace")}
                >
                  <SelectValue placeholder={t("instructions.workspace")} />
                </SelectTrigger>
                <SelectContent>
                  {workspaces.map((workspace) => (
                    <SelectItem key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="mt-2">
              <InstructionPreview text={preview} />
            </div>
          </details>
        </div>
      </div>
      {failed && (
        <p role="alert" className="text-app-ui-sm text-[var(--state-error-fg)]">
          {t("instructions.saveFailed")}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <p className="text-app-ui-sm text-muted-foreground">{t("instructions.applies")}</p>
        <div className="flex shrink-0 gap-1.5">
          <Button
            variant="outline"
            size="sm"
            disabled={saving || edits.length === 0}
            onClick={() => {
              setDrafts({});
              setFailed(false);
            }}
          >
            {t("common:action.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={
              saving ||
              edits.length === 0 ||
              edits.some((edit) => !InstructionTextSchema.safeParse(edit.text).success)
            }
            onClick={() => void save()}
          >
            {t("common:action.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
