import type * as Monaco from "monaco-editor";
import { preAcquireLocationModels } from "./lsp-result-preacquire";

export type MonacoCompensationInstaller = (monaco: typeof Monaco) => Monaco.IDisposable;

export interface InstallMonacoCompensationsOptions {
  installers?: readonly MonacoCompensationInstaller[];
}

export interface InstallLocationModelPreAcquireOptions {
  preAcquireLocationModels?: typeof preAcquireLocationModels;
}

export interface LocationModelPreAcquireInstallation extends Monaco.IDisposable {
  preAcquireLocationModels: typeof preAcquireLocationModels;
}

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
  const preAcquire = options.preAcquireLocationModels ?? preAcquireLocationModels;
  return {
    preAcquireLocationModels: (...args) => preAcquire(...args),
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
