import type * as Monaco from "monaco-editor";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { setPreAcquireFn } from "../lsp/lsp-bridge";
import {
  acquireModel,
  cacheUriToFilePath,
  getEntryMetadata,
  releaseModel,
} from "../model/model-cache";
import {
  preAcquireLocationModels,
  type PreAcquireDeps,
} from "../lsp/lsp-result-preacquire";

export type MonacoCompensationInstaller = (monaco: typeof Monaco) => Monaco.IDisposable;

export interface InstallMonacoCompensationsOptions {
  installers?: readonly MonacoCompensationInstaller[];
}

export interface InstallLocationModelPreAcquireOptions {
  /**
   * Override the entire preAcquireLocationModels function. Used in tests to
   * bypass model-cache deps without mock.module pollution.
   */
  preAcquireLocationModels?: typeof preAcquireLocationModels;
  /**
   * Override only the deps map. Mutually exclusive with preAcquireLocationModels.
   * When provided without preAcquireLocationModels, wraps the real function
   * with these deps.
   */
  preAcquireDeps?: PreAcquireDeps;
}

export interface LocationModelPreAcquireInstallation extends Monaco.IDisposable {
  preAcquireLocationModels: typeof preAcquireLocationModels;
}

/**
 * Production deps for preAcquireLocationModels.
 * Constructed here (the installation seam) so lsp-result-preacquire does not
 * import from model-cache at the module level, breaking the 6-module cycle:
 * model-cache → load-external-entry → model-entry → lsp-bridge →
 * lsp-providers → lsp-result-preacquire → model-cache.
 */
export const defaultPreAcquireDeps: PreAcquireDeps = {
  acquireModel,
  releaseModel,
  getEntryMetadata,
  cacheUriToFilePath,
  workspaceRootForId(workspaceId) {
    const ws = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
    return ws?.rootPath ?? null;
  },
};

export function installEditorOpener(
  monaco: typeof Monaco,
  opener: Monaco.editor.ICodeEditorOpener,
): Monaco.IDisposable {
  return monaco.editor.registerEditorOpener(opener);
}

export function installLocationModelPreAcquire(
  _monaco: typeof Monaco,
  options: InstallLocationModelPreAcquireOptions = {},
): LocationModelPreAcquireInstallation {
  const preAcquireFn = options.preAcquireLocationModels;
  const deps = options.preAcquireDeps ?? defaultPreAcquireDeps;

  if (preAcquireFn) {
    // Test path: full function override. Wire the curried form into lsp-bridge.
    setPreAcquireFn((locations, sourceUri) => preAcquireFn(locations, sourceUri, deps));
    return {
      preAcquireLocationModels: (locations, sourceUri, overrideDeps) =>
        preAcquireFn(locations, sourceUri, overrideDeps),
      dispose() {},
    };
  }

  // Production path: build curried closure from deps and wire into lsp-bridge.
  const curried = (
    locations: readonly Monaco.languages.Location[],
    sourceUri: string,
  ): Promise<void> => preAcquireLocationModels(locations, sourceUri, deps);

  setPreAcquireFn(curried);

  return {
    preAcquireLocationModels: (locations, sourceUri, overrideDeps) =>
      preAcquireLocationModels(locations, sourceUri, overrideDeps),
    dispose() {},
  };
}

export function installMonacoCompensations(
  monaco: typeof Monaco,
  options: InstallMonacoCompensationsOptions = {},
): Monaco.IDisposable {
  const installers = options.installers ?? [installLocationModelPreAcquire];
  const disposables = installers.map((install) => install(monaco));

  return {
    dispose() {
      for (let idx = disposables.length - 1; idx >= 0; idx -= 1) {
        disposables[idx]?.dispose();
      }
    },
  };
}
