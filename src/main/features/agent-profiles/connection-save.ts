import os from "node:os";
import {
  type ConnectionKeyChange,
  normalizeConnectionUrl,
} from "../../../shared/agent-profiles/connection";
import {
  type AgentProfile,
  defaultProfileId,
  EMPTY_AGENT_PROFILES,
  isDefaultProfileId,
  MAX_AGENT_PROFILES,
  PROFILE_AGENTS,
  profileDirConflict,
  profilesOf,
  withProfile,
} from "../../../shared/agent-profiles/profiles";
import { EMPTY_INSTRUCTIONS, withInstruction } from "../../../shared/chat/instructions";
import { broadcast } from "../../infra/ipc-router";
import type { StateService } from "../../infra/storage/state-service";
import type { ConnectionKeys } from "./connection-keys";
import { sameLaunchConnection } from "./connection-launch";
import { localDefaultDir } from "./local";

/** A validation error whose message can be shown without including input values. */
export class ProfileValidationError extends Error {}

/** The profile of that id, of either agent. */
export function findProfile(state: StateService, id: string): AgentProfile | null {
  const config = state.getState().agentProfiles ?? EMPTY_AGENT_PROFILES;
  for (const agent of PROFILE_AGENTS) {
    const found = profilesOf(config, agent).find((p) => p.id === id);
    if (found) return found;
  }
  return null;
}

export function pruneProfileKeys(
  keys: ConnectionKeys,
  state: Pick<StateService, "getState" | "flushNow">,
): Promise<void> {
  return keys.prune(() => {
    // A restart can still load a removed profile until its removal is durable.
    state.flushNow();
    const config = state.getState().agentProfiles ?? EMPTY_AGENT_PROFILES;
    return new Set(
      PROFILE_AGENTS.flatMap((agent) => profilesOf(config, agent).map(({ id }) => id)),
    );
  });
}

function normalizedProfile(profile: AgentProfile): AgentProfile {
  const { id, agent, connection } = profile;
  if (isDefaultProfileId(id) && id !== defaultProfileId(agent)) {
    throw new ProfileValidationError("Profile does not belong to this agent");
  }
  if (connection?.method !== "custom") return profile;
  let baseUrl: string;
  try {
    baseUrl = normalizeConnectionUrl(agent, connection.baseUrl);
  } catch {
    throw new ProfileValidationError("Invalid API address");
  }
  const ids = new Set(connection.models.map(({ id }) => id));
  if (ids.size !== connection.models.length) {
    throw new ProfileValidationError("Model IDs must be unique");
  }
  if (
    !ids.has(connection.defaultModel) ||
    (connection.lightModel && !ids.has(connection.lightModel))
  ) {
    throw new ProfileValidationError(
      "The default and light models must be among the listed models",
    );
  }
  return { ...profile, connection: { ...connection, baseUrl } };
}

export function createProfileConnections(
  state: StateService,
  keys: ConnectionKeys,
  onChanged: (connectionChangedProfileId?: string) => void,
) {
  const config = () => state.getState().agentProfiles ?? EMPTY_AGENT_PROFILES;
  const checkFolder = (next: AgentProfile, existing: AgentProfile | null) => {
    if (isDefaultProfileId(next.id) || existing?.dir === next.dir) return;
    const taken = profilesOf(config(), next.agent)
      .filter(({ id }) => id !== next.id)
      .map(({ dir }) => dir);
    const conflict = profileDirConflict(
      next.agent,
      next.dir,
      taken,
      { home: os.homedir(), windows: process.platform === "win32" },
      localDefaultDir(next.agent),
    );
    if (conflict === "default")
      throw new ProfileValidationError("This is the default profile folder");
    if (conflict === "taken")
      throw new ProfileValidationError("A profile already uses this folder");
  };
  const checkAdd = (next: AgentProfile) => {
    const current = config();
    if (current.profiles.length >= MAX_AGENT_PROFILES) {
      throw new ProfileValidationError(`At most ${MAX_AGENT_PROFILES} profiles can be saved`);
    }
    if (findProfile(state, next.id))
      throw new ProfileValidationError("This profile ID already exists");
    const name = next.name.trim().toLowerCase();
    if (
      profilesOf(current, next.agent).some((p) => {
        const otherName =
          p.name.trim().toLowerCase() || (isDefaultProfileId(p.id) ? "default" : p.id);
        return otherName === name || p.id.toLowerCase() === name;
      })
    ) {
      throw new ProfileValidationError("A profile already uses this name for this agent");
    }
    checkFolder(next, null);
  };
  return {
    config,
    checkNew(profile: AgentProfile): AgentProfile {
      const next = normalizedProfile(profile);
      checkAdd(next);
      return next;
    },
    async save(
      {
        profile,
        key,
        instructions,
      }: {
        profile: AgentProfile;
        key?: ConnectionKeyChange;
        instructions?: string;
      },
      add?: { signal?: AbortSignal },
    ) {
      const next = normalizedProfile(profile);
      let connectionChanged = false;
      const keyChanged = await keys.saveProfile(
        next,
        key,
        () => {
          add?.signal?.throwIfAborted();
          const agentProfiles = config();
          const existing = findProfile(state, next.id);
          if (existing && existing.agent !== next.agent) {
            throw new ProfileValidationError("Profile does not belong to this agent");
          }
          if (add) checkAdd(next);
          else {
            if (
              agentProfiles.profiles.length >= MAX_AGENT_PROFILES &&
              !agentProfiles.profiles.some(({ id }) => id === next.id)
            ) {
              throw new ProfileValidationError(
                `At most ${MAX_AGENT_PROFILES} profiles can be saved`,
              );
            }
            checkFolder(next, existing);
          }
          connectionChanged = !sameLaunchConnection(existing, next);
          const current = state.getState();
          const agentInstructions =
            instructions === undefined
              ? undefined
              : withInstruction(current.agentInstructions ?? EMPTY_INSTRUCTIONS, {
                  scope: { kind: "profile", id: next.id },
                  text: instructions,
                });
          state.commitState({
            agentProfiles: withProfile(agentProfiles, next),
            ...(agentInstructions ? { agentInstructions } : {}),
          });
        },
        findProfile(state, next.id),
      );
      if (instructions !== undefined) {
        broadcast("appState", "agentInstructionsChanged", {
          config: state.getState().agentInstructions ?? EMPTY_INSTRUCTIONS,
        });
      }
      onChanged(connectionChanged || keyChanged ? next.id : undefined);
      return config();
    },
  };
}

export type ProfileConnections = ReturnType<typeof createProfileConnections>;
