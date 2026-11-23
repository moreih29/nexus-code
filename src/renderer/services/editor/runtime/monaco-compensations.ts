import type * as Monaco from "monaco-editor";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { setPreAcquireFn } from "../lsp/bridge";
import { type PreAcquireDeps, preAcquireLocationModels } from "../lsp/result-preacquire";
import { acquireModel, cacheUriToFilePath, getEntryMetadata, releaseModel } from "../model/cache";

export type MonacoCompensationInstaller = (monaco: typeof Monaco) => Monaco.IDisposable;

export interface InstallMonacoCompensationsOptions {
  installers?: readonly MonacoCompensationInstaller[];
}

export interface InstallLocationModelPreAcquireOptions {
  preAcquireLocationModels?: typeof preAcquireLocationModels;
  preAcquireDeps?: PreAcquireDeps;
}

export interface LocationModelPreAcquireInstallation extends Monaco.IDisposable {
  preAcquireLocationModels: typeof preAcquireLocationModels;
}

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
    setPreAcquireFn((locations, sourceUri, token) =>
      preAcquireFn(locations, sourceUri, deps, token),
    );
    return {
      preAcquireLocationModels: (locations, sourceUri, overrideDeps) =>
        preAcquireFn(locations, sourceUri, overrideDeps),
      dispose() {},
    };
  }

  const curried = (
    locations: readonly Monaco.languages.Location[],
    sourceUri: string,
    token?: Monaco.CancellationToken,
  ): Promise<void> => preAcquireLocationModels(locations, sourceUri, deps, token);

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
