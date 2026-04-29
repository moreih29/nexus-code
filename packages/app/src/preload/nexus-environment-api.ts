import type { NexusPlatform } from "../common/platform";

export interface NexusEnvironmentApi {
  readonly platform: NexusPlatform;
}

export function createNexusEnvironmentApi(platform: NexusPlatform): NexusEnvironmentApi {
  return { platform };
}
