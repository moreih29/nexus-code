import { createRoot } from "react-dom/client";
import { App } from "./app";
import { installWindowErrorHandlers } from "./services/window-error-handler";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Root element not found");
}

// Install the unified window 'error' + 'unhandledrejection' safety net before
// mounting React. Cancellation rejections are silenced; all other errors are
// forwarded to the shared log facade (IPC relay → main-process log file).
//
// NOTE: <StrictMode> intentionally omitted. TerminalView / EditorView own
// stateful external resources (node-pty processes, Monaco model bindings)
// that cannot be made idempotent across StrictMode's double-invoke pattern
// without race conditions. StrictMode is a no-op in production builds, so
// disabling it only affects dev-mode warnings.
installWindowErrorHandlers();
createRoot(root).render(<App />);
