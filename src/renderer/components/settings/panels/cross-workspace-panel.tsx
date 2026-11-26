import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { shortId } from "../../../../shared/util/short-id";
import { ipcCallResult } from "../../../ipc/client";
import type { CallReturn } from "../../../ipc/types";
import { useAgentCliStore } from "../../../state/stores/agent-cli";
import { useTabsStore } from "../../../state/stores/tabs";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { Button } from "../../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { SettingsGroup, SettingsPage, SettingsRow } from "../section";
import { SegmentedControl } from "../segmented-control";

type Grants = CallReturn<"cli", "workspaceGrants">;

export function CrossWorkspacePanel({ go }: { go: (id: string) => void }) {
  const { t } = useTranslation("settings");
  const enabled = useAgentCliStore((s) => s.enabled);
  const policy = useAgentCliStore((s) => s.crossWorkspace);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const tabs = useTabsStore((s) => s.byWorkspace);
  const [grants, setGrants] = useState<Grants | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const options = grants && workspaces.filter((w) => !w.task && !grants.preallowed.includes(w.id));
  const workspaceName = (id: string) =>
    workspaces.find((workspace) => workspace.id === id)?.name ?? shortId(id);
  const callerName = (workspace: string, tab: string) =>
    [workspaceName(workspace), tabs[workspace]?.[tab]?.title, shortId(tab)]
      .filter(Boolean)
      .join(" · ");
  const label = t("agentCli.crossWorkspace.label");

  const load = useCallback(async (signal?: AbortSignal) => {
    const result = await ipcCallResult("cli", "workspaceGrants", undefined, { signal }).catch(
      () => undefined,
    );
    if (signal?.aborted) return;
    if (result?.ok) setGrants(result.value);
    else setFailed(true);
  }, []);

  useEffect(() => {
    if (busy) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      await load(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(refresh, 2_000);
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [busy, load]);

  async function update(action: () => Promise<{ ok: boolean }>) {
    setBusy(true);
    try {
      const result = await action();
      setFailed(!result.ok);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  function setPreallowed(id: string, allowed: boolean) {
    void update(async () => {
      const result = await ipcCallResult("cli", "setWorkspaceGrant", { workspaceId: id, allowed });
      if (result.ok && allowed) setWorkspaceId("");
      return result;
    });
  }

  return (
    <SettingsPage>
      <SettingsGroup>
        <SettingsRow label={label} description={t("agentCli.crossWorkspace.description")}>
          <SegmentedControl
            options={(["ask", "allow", "deny"] as const).map((value) => ({
              value,
              label: t(`agentCli.crossWorkspace.${value}`),
            }))}
            value={policy}
            onChange={(next) =>
              void update(async () => {
                const result = await ipcCallResult("appState", "set", { cliCrossWorkspace: next });
                if (result.ok) useAgentCliStore.getState().set({ crossWorkspace: next });
                return result;
              })
            }
            label={label}
            disabled={!enabled || busy}
          />
        </SettingsRow>
        <SettingsRow
          label={t("nav.remote")}
          description={t("agentCli.crossWorkspace.remoteDescription")}
        >
          <Button size="sm" variant="outline" onClick={() => go("remote")}>
            {t("agentCli.crossWorkspace.openRemote")}
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title={t("agentCli.crossWorkspace.preallowed")}
        description={t("agentCli.crossWorkspace.preallowedDescription")}
      >
        {options && options.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Select value={workspaceId} onValueChange={setWorkspaceId} disabled={busy}>
              <SelectTrigger ariaLabel={t("agentCli.crossWorkspace.choose")}>
                <SelectValue placeholder={t("agentCli.crossWorkspace.choose")} />
              </SelectTrigger>
              <SelectContent>
                {options.map((workspace) => (
                  <SelectItem key={workspace.id} value={workspace.id}>
                    {workspace.name} · {workspace.rootPath}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !options.some(({ id }) => id === workspaceId)}
              onClick={() => setPreallowed(workspaceId, true)}
            >
              {t("agentCli.crossWorkspace.add")}
            </Button>
          </div>
        )}
        {grants?.preallowed.map((id) => (
          <SettingsRow
            key={id}
            label={workspaceName(id)}
            description={workspaces.find((workspace) => workspace.id === id)?.rootPath}
          >
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setPreallowed(id, false)}
            >
              {t("agentCli.crossWorkspace.revoke")}
            </Button>
          </SettingsRow>
        ))}
        {grants?.preallowed.length === 0 && <EmptyGrants />}
      </SettingsGroup>

      <SettingsGroup
        title={t("agentCli.crossWorkspace.sessions")}
        description={t("agentCli.crossWorkspace.sessionsDescription")}
      >
        {grants?.sessions.map(({ id, workspaceId, fromWorkspaceId, fromTabId }) => (
          <SettingsRow
            key={id}
            label={workspaceName(workspaceId)}
            description={callerName(fromWorkspaceId, fromTabId)}
          >
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void update(() => ipcCallResult("cli", "revokeSessionGrant", { id }))}
            >
              {t("agentCli.crossWorkspace.revoke")}
            </Button>
          </SettingsRow>
        ))}
        {grants?.sessions.length === 0 && <EmptyGrants />}
      </SettingsGroup>
      {failed && (
        <p role="alert" className="text-app-ui-sm text-destructive">
          {t("agentCli.crossWorkspace.saveFailed")}
        </p>
      )}
    </SettingsPage>
  );
}

function EmptyGrants() {
  const { t } = useTranslation("settings");
  return (
    <p className="text-app-ui-sm text-muted-foreground">{t("agentCli.crossWorkspace.empty")}</p>
  );
}
