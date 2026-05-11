export {
  defaultPreAcquireDeps,
  type InstallLocationModelPreAcquireOptions,
  type InstallMonacoCompensationsOptions,
  installEditorOpener,
  installLocationModelPreAcquire,
  installMonacoCompensations,
  type LocationModelPreAcquireInstallation,
  type MonacoCompensationInstaller,
} from "./monaco-compensations";
export {
  initializeMonacoSingleton,
  isMonacoReady,
  onMonacoReady,
  requireMonaco,
} from "./monaco-singleton";
export {
  buildEditorColors,
  initializeMonacoTheme,
  NEXUS_DARK_THEME_NAME,
} from "./monaco-theme";
export { installRejectionSink } from "./rejection-sink";
