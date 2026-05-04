// Global test setup — preloaded by bunfig.toml.
//
// Purpose:
// 1. Enable React's act() environment so RTL render calls do not flood stdout
//    with "current testing environment is not configured to support act(...)".
// 2. Filter out the React useSyncExternalStore "result of getSnapshot should be
//    cached" warning. Our slot-registry returns reference-stable values (HTMLElement
//    or null) per (workspaceId, leafId) key, so the warning is a false positive
//    triggered by RTL re-render churn under happy-dom. Suppressing it locally
//    keeps test output readable; production code is unaffected.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalError = console.error;
console.error = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === "string") {
    if (first.includes("not configured to support act")) return;
    if (first.includes("should be wrapped into act")) return;
    if (first.includes("getSnapshot should be cached")) return;
  }
  originalError(...args);
};
