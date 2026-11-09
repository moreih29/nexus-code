// The agentProfiles IPC channel: Settings' view of the profiles on this machine.

import os from "node:os";
import { shell } from "electron";
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

export function registerAgentProfilesChannel(state: StateService): { dispose(): void } {
  const logins = new LocalLogins({
    output: (id, text) => broadcast("agentProfiles", "loginOutput", { id, text }),
    exit: (id, code) => broadcast("agentProfiles", "loginExit", { id, code }),
  });
  const profile = (id: string): AgentProfile => {
    const found = findProfile(state, id);
    if (!found) throw new Error(`no profile ${id}`);
    return found;
  };

  register("agentProfiles", {
    call: {
      home: async () =>
        ipcOk({
          home: os.homedir(),
          defaultDirs: { claude: localDefaultDir("claude"), codex: localDefaultDir("codex") },
        }),
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
