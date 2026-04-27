import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SIDECAR_BINARY_NAME =
  process.platform === "win32" ? "nexus-sidecar.exe" : "nexus-sidecar";

const MAIN_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export interface SidecarBinaryResolutionOptions {
  appPath: string;
  cwd: string;
  resourcesPath: string;
  isPackaged: boolean;
  existsSyncFn?: (candidatePath: string) => boolean;
}

export function resolveSidecarBinaryPath(
  options: SidecarBinaryResolutionOptions,
): string | null {
  const existsSyncFn = options.existsSyncFn ?? existsSync;
  const packagedCandidate = path.resolve(
    options.resourcesPath,
    "sidecar",
    SIDECAR_BINARY_NAME,
  );
  const devCandidate = findDevSidecarBinaryPath(
    [options.appPath, options.cwd, MAIN_MODULE_DIR],
    existsSyncFn,
  );

  if (options.isPackaged) {
    return existsSyncFn(packagedCandidate) ? packagedCandidate : null;
  }

  if (devCandidate) {
    return devCandidate;
  }

  return existsSyncFn(packagedCandidate) ? packagedCandidate : null;
}

function findDevSidecarBinaryPath(
  searchRoots: string[],
  existsSyncFn: (candidatePath: string) => boolean,
): string | null {
  const visitedRoots = new Set<string>();

  for (const root of searchRoots) {
    if (!root || root.trim().length === 0) {
      continue;
    }

    let cursor = path.resolve(root);
    while (true) {
      if (visitedRoots.has(cursor)) {
        break;
      }

      visitedRoots.add(cursor);
      const candidatePath = path.join(cursor, "sidecar", "bin", SIDECAR_BINARY_NAME);
      if (existsSyncFn(candidatePath)) {
        return candidatePath;
      }

      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }

      cursor = parent;
    }
  }

  return null;
}
