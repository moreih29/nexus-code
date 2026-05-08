import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installRejectionSink } from "./services/editor/runtime/rejection-sink";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Root element not found");
}

// NOTE: <StrictMode> intentionally omitted. TerminalView / EditorView own
// stateful external resources (node-pty processes, Monaco model bindings)
// that cannot be made idempotent across StrictMode's double-invoke pattern
// without race conditions. StrictMode is a no-op in production builds, so
// disabling it only affects dev-mode warnings.
installRejectionSink();
createRoot(root).render(<App />);
