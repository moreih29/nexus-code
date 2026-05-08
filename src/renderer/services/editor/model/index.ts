export {
  acquireModel,
  cacheUriToFilePath,
  filePathToModelUri,
  forceDisposeExternalsForWorkspace,
  getEntryMetadata,
  getModelSnapshot,
  getResolvedModel,
  initializeModelCache,
  releaseModel,
  subscribeModel,
  subscribeOnRelease,
  toFileErrorCode,
  type EntryMetadata,
  type ReleasedModelInfo,
  type ResolvedModelView,
  type SharedModelPhase,
  type SharedModelState,
} from "./model-cache";
export {
  attachDirtyTracker,
  detachDirtyTracker,
  getDirtyEntry,
  isDirty,
  markSaved,
  subscribeAllDirtyTransitions,
  subscribeAllSaved,
  subscribeFileDirty,
  updateLoadedMetadata,
  __resetDirtyTrackerForTests,
  type AttachOptions,
  type DirtyEntry,
  type DirtyTransitionEvent,
  type DirtyTransitionListener,
  type MarkSavedOptions,
} from "./dirty-tracker";
export { relPathForInput, workspaceRootForInput } from "./file-loader";
export { useSharedModel } from "./use-shared-model";
export { ensureModelWithContent } from "./ensure-model";
