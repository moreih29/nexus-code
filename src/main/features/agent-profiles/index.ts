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
  EMPTY_AGENT_PROFILES,
  PROFILE_AGENTS,
  profilesOf,
} from "../../../shared/agent-profiles/profiles";
import { ipcContract } from "../../../shared/ipc/contract";
import { ipcOk } from "../../../shared/ipc/result";
import { broadcast, register, validateArgs } from "../../infra/ipc-router";
import type { StateService } from "../../infra/storage/state-service";
import { readBehavior, unshareBehaviorFile, writeBehavior } from "./behavior";
import type { ConnectionKeys } from "./connection-keys";
import { discoverConnectionModels, testConnection } from "./connection-probe";
import { findProfile, type ProfileConnections } from "./connection-save";
import {
  inspectLocalFolder,
  LocalLogins,
  localDefaultDir,
  localProfileStatus,
  prepareLocalProfile,
} from "./local";

const c = ipcContract.agentProfiles.call;

export { findProfile } from "./connection-save";

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
  connections: ProfileConnections,
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
      connectionSave: async (args: unknown) =>
        ipcOk(await connections.save(validateArgs(c.connectionSave.args, args))),
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
