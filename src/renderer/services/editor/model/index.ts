export {
  __resetDirtyTrackerForTests,
  type AttachOptions,
  attachDirtyTracker,
  type DirtyEntry,
  type DirtyTransitionEvent,
  type DirtyTransitionListener,
  detachDirtyTracker,
  getDirtyEntry,
  isDirty,
  type MarkSavedOptions,
  markSaved,
  subscribeAllDirtyTransitions,
  subscribeAllSaved,
  subscribeFileDirty,
  updateLoadedMetadata,
} from "./dirty-tracker";
export { ensureModelWithContent } from "./ensure-model";
export { relPathForInput, workspaceRootForInput } from "./file-loader";
export {
  acquireModel,
  cacheUriToFilePath,
  type EntryMetadata,
  filePathToModelUri,
  forceDisposeExternalsForWorkspace,
  getEntryMetadata,
  getModelSnapshot,
  getResolvedModel,
  initializeModelCache,
  type ReleasedModelInfo,
  type ResolvedModelView,
  releaseModel,
  type SharedModelPhase,
  type SharedModelState,
  subscribeModel,
  subscribeOnRelease,
  toFileErrorCode,
} from "./model-cache";
export { useSharedModel } from "./use-shared-model";
