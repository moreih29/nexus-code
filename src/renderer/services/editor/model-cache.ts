// Monaco TextModel reference counting.
// Mirrors VSCode ITextModelService — models are owned by the cache, not by editor instances.
// Public surface: useSharedModel(uri) hook + acquire/release primitives.

export {};
