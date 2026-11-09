/**
 * Settings › Profiles by workspace: which Claude and Codex profile each
 * workspace runs with. A default for each agent, then rules for a folder
 * (and every folder in it), an SSH host or one workspace; a workspace's own
 * rule beats the deepest folder it is in, which beats its SSH host. A rule
 * may set one agent and leave the other to the next. The result for every
 * workspace shows under the rules.
 */

import { ChevronDown, Folder, Globe, Monitor, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import {
  PROFILE_AGENTS,
  type ProfileRule,
  type ProfileTarget,
  profilesOf,
  resolveProfile,
  ruleMatches,
} from "../../../../shared/agent-profiles/profiles";
import type { ChatAgent } from "../../../../shared/sessions/task-agent";
import { ipcCallResult } from "../../../ipc/client";
import {
  matchOptions,
  profileWorkspace,
  tildePath,
  useAgentProfilesStore,
} from "../../../state/stores/agent-profiles";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { ProfileDot, profileName } from "../../agent-profiles/profile-badge";
import { ProfileSelect } from "../../agent-profiles/profile-select";
import { Button } from "../../ui/button";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { SettingsGroup, SettingsPage, SettingsRow } from "../section";

const AGENT_NAMES: Record<ChatAgent, string> = { claude: "Claude", codex: "Codex" };

const iconButtonClass = cn(
  "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center",
  "rounded-(--radius-control) text-muted-foreground transition-colors",
  "hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
);

function sshName(location: { kind: string; configAlias?: string; host?: string }): string | null {
  if (location.kind !== "ssh") return null;
  return location.configAlias || location.host || null;
}

export function ProfileRulesPanel() {
  const { t } = useTranslation("settings");
  const config = useAgentProfilesStore((s) => s.config);
  const home = useAgentProfilesStore((s) => s.home);
  const setDefault = useAgentProfilesStore((s) => s.setDefault);
  const setRuleKeep = useAgentProfilesStore((s) => s.setRuleKeep);
  const addRule = useAgentProfilesStore((s) => s.addRule);
  const removeRule = useAgentProfilesStore((s) => s.removeRule);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const [sshHosts, setSshHosts] = useState<string[] | null>(null);
  const [showResults, setShowResults] = useState(false);

  const profiles = useMemo(
    () => ({ claude: profilesOf(config, "claude"), codex: profilesOf(config, "codex") }),
    [config],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `home` changes how paths match
  const options = useMemo(() => matchOptions(), [home]);
  const shown = workspaces.filter((w) => !w.task);
  const targets = useMemo(() => new Set(config.rules.map((r) => targetKey(r.target))), [config]);

  const loadSshHosts = () => {
    if (sshHosts !== null) return;
    void ipcCallResult("ssh", "listConfigHosts", undefined).then((result) => {
      const fromConfig = result.ok ? result.value.map((h) => h.alias) : [];
      const fromWorkspaces = workspaces
        .map((w) => sshName(w.location as never))
        .filter((n): n is string => !!n);
      setSshHosts([...new Set([...fromWorkspaces, ...fromConfig])].filter((h) => !h.includes("*")));
    });
  };

  const addFolder = async () => {
    const result = await ipcCallResult("dialog", "showOpenDirectory", {
      title: t("profileRules.folderPick"),
    });
    const path = result.ok && !result.value.canceled ? result.value.filePaths[0] : undefined;
    if (path) addRule({ kind: "folder", path });
  };

  const label = (rule: ProfileRule): { icon: typeof Folder; text: string; sub: string } => {
    const { target } = rule;
    if (target.kind === "folder") {
      return {
        icon: Folder,
        text: tildePath(target.path, home),
        sub: t("profileRules.folderTarget"),
      };
    }
    if (target.kind === "ssh")
      return { icon: Globe, text: target.host, sub: t("profileRules.sshTarget") };
    const ws = workspaces.find((w) => w.id === target.workspaceId);
    return {
      icon: Monitor,
      text: ws?.name ?? target.workspaceId.slice(0, 8),
      sub: t("profileRules.workspaceTarget"),
    };
  };

  const applies = (rule: ProfileRule) =>
    shown.filter((w) => ruleMatches(rule, profileWorkspace(w, workspaces), options)).length;

  return (
    <SettingsPage>
      <SettingsGroup
        title={t("profileRules.defaults")}
        description={t("profileRules.defaultsDescription")}
      >
        {PROFILE_AGENTS.map((agent) => (
          <SettingsRow key={agent} label={AGENT_NAMES[agent]}>
            <ProfileSelect
              agent={agent}
              profiles={profiles[agent]}
              value={config.defaults[agent] ?? profiles[agent][0]?.id}
              onChange={(id) => setDefault(agent, id)}
            />
          </SettingsRow>
        ))}
      </SettingsGroup>

      <SettingsGroup
        title={t("profileRules.rules")}
        description={t("profileRules.rulesDescription")}
        action={
          <DropdownMenuRoot onOpenChange={(open) => open && loadSshHosts()}>
            <DropdownMenuTrigger>
              <Button variant="outline" size="sm" data-testid="profile-rules-add">
                <Plus aria-hidden="true" />
                {t("profileRules.add")}
                <ChevronDown aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void addFolder()}>
                <span className="flex items-center gap-2">
                  <Folder className="size-3.5" aria-hidden="true" />
                  {t("profileRules.addFolder")}
                </span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t("profileRules.pickSsh")}</DropdownMenuLabel>
              {(sshHosts ?? [])
                .filter((host) => !targets.has(targetKey({ kind: "ssh", host })))
                .map((host) => (
                  <DropdownMenuItem key={host} onSelect={() => addRule({ kind: "ssh", host })}>
                    <span className="flex items-center gap-2">
                      <Globe className="size-3.5" aria-hidden="true" />
                      {host}
                    </span>
                  </DropdownMenuItem>
                ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t("profileRules.pickWorkspace")}</DropdownMenuLabel>
              {shown
                .filter((w) => !targets.has(targetKey({ kind: "workspace", workspaceId: w.id })))
                .map((w) => (
                  <DropdownMenuItem
                    key={w.id}
                    onSelect={() => addRule({ kind: "workspace", workspaceId: w.id })}
                  >
                    <span className="flex items-center gap-2">
                      <Monitor className="size-3.5" aria-hidden="true" />
                      {w.name}
                    </span>
                  </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenuRoot>
        }
      >
        {config.rules.length === 0 ? (
          <p className="text-app-ui-sm text-muted-foreground">{t("profileRules.empty")}</p>
        ) : (
          <div className="flex flex-col" data-testid="profile-rules">
            <div className="grid grid-cols-[minmax(0,1fr)_8rem_8rem_2.5rem_1.75rem] items-center gap-2 px-2 pb-1 text-app-label uppercase text-muted-foreground">
              <span>{t("profileRules.target")}</span>
              <span>Claude</span>
              <span>Codex</span>
              <span className="text-right">{t("profileRules.applies")}</span>
              <span />
            </div>
            {config.rules.map((rule) => {
              const { icon: Icon, text, sub } = label(rule);
              return (
                <div
                  key={rule.id}
                  className="grid grid-cols-[minmax(0,1fr)_8rem_8rem_2.5rem_1.75rem] items-center gap-2 rounded-(--radius-control) px-2 py-1 hover:bg-[var(--state-hover-bg)]"
                  data-testid="profile-rule"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-app-body text-foreground" title={text}>
                        {text}
                      </span>
                      <span className="truncate text-app-micro text-muted-foreground">{sub}</span>
                    </span>
                  </span>
                  {PROFILE_AGENTS.map((agent) => (
                    <ProfileSelect
                      key={agent}
                      agent={agent}
                      profiles={profiles[agent]}
                      value={rule[agent]}
                      inherit={t("profileRules.inherit")}
                      onChange={(id) => setRuleKeep(rule.target, agent, id)}
                      className="w-full"
                    />
                  ))}
                  <span className="text-right text-app-ui-sm text-muted-foreground">
                    {t("profileRules.appliesCount", { count: applies(rule) })}
                  </span>
                  <button
                    type="button"
                    aria-label={t("profileRules.remove")}
                    title={t("profileRules.remove")}
                    onClick={() => removeRule(rule.id)}
                    className={iconButtonClass}
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <p className="text-app-ui-sm text-muted-foreground">{t("profileRules.hint")}</p>
      </SettingsGroup>

      <SettingsGroup>
        <button
          type="button"
          aria-expanded={showResults}
          onClick={() => setShowResults((v) => !v)}
          className="flex items-center gap-1.5 self-start text-app-ui-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronDown
            className={cn("size-3.5 transition-transform", !showResults && "-rotate-90")}
          />
          {t("profileRules.results")} · {t("profileRules.resultsCount", { count: shown.length })}
        </button>
        {showResults && (
          <div className="flex flex-col" data-testid="profile-results">
            {shown.map((w) => {
              const subject = profileWorkspace(w, workspaces);
              return (
                <div
                  key={w.id}
                  className="grid grid-cols-[minmax(0,1fr)_8rem_8rem_2.5rem_1.75rem] items-center gap-2 px-2 py-1"
                >
                  <span className="truncate text-app-body text-foreground" title={w.rootPath}>
                    {w.name}
                  </span>
                  {PROFILE_AGENTS.map((agent) => {
                    const { profile } = resolveProfile(config, agent, subject, options);
                    return (
                      <span
                        key={agent}
                        className="flex min-w-0 items-center gap-1.5 px-2 text-app-ui-sm"
                      >
                        <ProfileDot color={profile.color} />
                        <span className="truncate">{profileName(profile, t)}</span>
                      </span>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}

function targetKey(target: ProfileTarget): string {
  if (target.kind === "workspace") return `w:${target.workspaceId}`;
  if (target.kind === "folder") return `f:${target.path}`;
  return `s:${target.host.toLowerCase()}`;
}
