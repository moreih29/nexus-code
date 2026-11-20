// The agentProfiles IPC channel: Settings' view of the profiles on this machine.

import os from "node:os";
import { shell } from "electron";
import {
  type ConnectionProbe,
  connectionKeyTarget,
  normalizeConnectionUrl,
} from "../../../shared/agent-profiles/connection";
import {
  type AgentProfile,
  defaultProfileId,
  EMPTY_AGENT_PROFILES,
  isDefaultProfileId,
  PROFILE_AGENTS,
  profilesOf,
  withProfile,
} from "../../../shared/agent-profiles/profiles";
import { EMPTY_INSTRUCTIONS, withInstruction } from "../../../shared/chat/instructions";
import { ipcContract } from "../../../shared/ipc/contract";
import { ipcOk } from "../../../shared/ipc/result";
import { broadcast, register, validateArgs } from "../../infra/ipc-router";
import type { StateService } from "../../infra/storage/state-service";
import { readBehavior, unshareBehaviorFile, writeBehavior } from "./behavior";
import type { ConnectionKeys } from "./connection-keys";
import { sameLaunchConnection } from "./connection-launch";
import { discoverConnectionModels, testConnection } from "./connection-probe";
import {
  inspectLocalFolder,
  LocalLogins,
  localDefaultDir,
  localProfileStatus,
  prepareLocalProfile,
} from "./local";

const c = ipcContract.agentProfiles.call;

/** The profile of that id, of either agent; null when there is none. */
export function findProfile(state: StateService, id: string): AgentProfile | null {
  const config = state.getState().agentProfiles ?? EMPTY_AGENT_PROFILES;
  for (const agent of PROFILE_AGENTS) {
    const found = profilesOf(config, agent).find((p) => p.id === id);
    if (found) return found;
  }
  return null;
}

export function profileKeyIds(state: StateService): ReadonlySet<string> {
  return new Set(
    PROFILE_AGENTS.flatMap((agent) =>
      profilesOf(state.getState().agentProfiles ?? EMPTY_AGENT_PROFILES, agent).map(({ id }) => id),
    ),
  );
}

export function registerAgentProfilesChannel(
  state: StateService,
  keys: ConnectionKeys,
  onChanged: (connectionChangedProfileId?: string) => void,
): { dispose(): void } {
  const logins = new LocalLogins({
    output: (id, text) => broadcast("agentProfiles", "loginOutput", { id, text }),
    exit: (id, code) => broadcast("agentProfiles", "loginExit", { id, code }),
  });
  const profile = (id: string): AgentProfile => {
    const found = findProfile(state, id);
    if (!found) throw new Error(`no profile ${id}`);
    return found;
  };

  const probeKey = async (probe: ConnectionProbe): Promise<string | undefined> => {
    if (probe.key !== undefined) return probe.key ?? undefined;
    if (!probe.profileId) return undefined;
    let baseUrl: string;
    try {
      baseUrl = normalizeConnectionUrl(probe.agent, probe.baseUrl);
    } catch {
      return undefined; // Let the probe return its structured address error.
    }
    const saved = findProfile(state, probe.profileId);
    if (saved?.agent !== probe.agent) return undefined;
    const target = connectionKeyTarget(probe.agent, {
      method: "custom",
      baseUrl,
      auth: probe.auth,
    });
    return keys.get(saved.id, target);
  };

  register("agentProfiles", {
    keepOnRendererClose: ["connectionSave"],
    call: {
      home: async () =>
        ipcOk({
          home: os.homedir(),
          defaultDirs: { claude: localDefaultDir("claude"), codex: localDefaultDir("codex") },
        }),
      connectionKeyStatus: async (args: unknown) => {
        const { profileId, target } = validateArgs(c.connectionKeyStatus.args, args);
        if (profileId) profile(profileId);
        return ipcOk(await keys.status(profileId, target));
      },
      connectionSave: async (args: unknown) => {
        const { profile: next, key, instructions } = validateArgs(c.connectionSave.args, args);
        const connection = next.connection;
        if (isDefaultProfileId(next.id) && next.id !== defaultProfileId(next.agent)) {
          throw new Error("Profile does not belong to this agent");
        }
        if (connection?.method === "custom") {
          connection.baseUrl = normalizeConnectionUrl(next.agent, connection.baseUrl);
          const ids = new Set(connection.models.map(({ id }) => id));
          if (
            ids.size !== connection.models.length ||
            !ids.has(connection.defaultModel) ||
            (connection.lightModel && !ids.has(connection.lightModel))
          )
            throw new Error("Select a default model and provide unique model IDs");
        }
        let connectionChanged = false;
        const keyChanged = await keys.saveProfile(next, key, () => {
          const current = state.getState();
          const existing = findProfile(state, next.id);
          if (existing && existing.agent !== next.agent)
            throw new Error("Profile does not belong to this agent");
          connectionChanged = !sameLaunchConnection(existing, next);
          const agentProfiles = withProfile(current.agentProfiles ?? EMPTY_AGENT_PROFILES, next);
          const agentInstructions =
            instructions === undefined
              ? undefined
              : withInstruction(current.agentInstructions ?? EMPTY_INSTRUCTIONS, {
                  scope: { kind: "profile", id: next.id },
                  text: instructions,
                });
          state.setState({ agentProfiles, ...(agentInstructions ? { agentInstructions } : {}) });
        });
        if (instructions !== undefined) {
          broadcast("appState", "agentInstructionsChanged", {
            config: state.getState().agentInstructions ?? EMPTY_INSTRUCTIONS,
          });
        }
        onChanged(connectionChanged || keyChanged ? next.id : undefined);
        return ipcOk(state.getState().agentProfiles ?? EMPTY_AGENT_PROFILES);
      },
      connectionDiscover: async (args: unknown) => {
        const probe = validateArgs(c.connectionDiscover.args, args);
        return ipcOk(await discoverConnectionModels(probe, await probeKey(probe)));
      },
      connectionTest: async (args: unknown) => {
        const { model, ...probe } = validateArgs(c.connectionTest.args, args);
        return ipcOk(await testConnection(probe, await probeKey(probe), model));
      },
      status: async (args: unknown) => {
        const { profileId } = validateArgs(c.status.args, args);
        return ipcOk(await localProfileStatus(profile(profileId)));
      },
      prepare: async (args: unknown) => {
        const { profileId } = validateArgs(c.prepare.args, args);
        return ipcOk(await prepareLocalProfile(profile(profileId)));
      },
      inspect: async (args: unknown) => {
        const { agent, dir } = validateArgs(c.inspect.args, args);
        return ipcOk(await inspectLocalFolder(agent, dir));
      },
      loginStart: async (args: unknown) => {
        const { profileId } = validateArgs(c.loginStart.args, args);
        return ipcOk(await logins.start(profile(profileId)));
      },
      loginInput: async (args: unknown) => {
        const { id, text } = validateArgs(c.loginInput.args, args);
        logins.input(id, text);
        return ipcOk(undefined);
      },
      loginCancel: async (args: unknown) => {
        logins.cancel(validateArgs(c.loginCancel.args, args).id);
        return ipcOk(undefined);
      },
      readBehavior: async (args: unknown) => {
        const { profileId, prepare } = validateArgs(c.readBehavior.args, args);
        return ipcOk(await readBehavior(profile(profileId), { prepare }));
      },
      writeBehavior: async (args: unknown) => {
        const { profileId, version, changes } = validateArgs(c.writeBehavior.args, args);
        return ipcOk(await writeBehavior(profile(profileId), version, changes));
      },
      unshareBehavior: async (args: unknown) => {
        const { profileId } = validateArgs(c.unshareBehavior.args, args);
        return ipcOk(await unshareBehaviorFile(profile(profileId)));
      },
      openUrl: async (args: unknown) => {
        const { url } = validateArgs(c.openUrl.args, args);
        if (new URL(url).protocol !== "https:") throw new Error("only https addresses open");
        await shell.openExternal(url);
        return ipcOk(undefined);
      },
    },
    listen: {
      loginOutput: {},
      loginExit: {},
    },
  });
  return { dispose: () => logins.dispose() };
}
