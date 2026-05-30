import { createRoot } from "react-dom/client";
import { createLogger } from "../shared/log/renderer";
import { App } from "./app";
import { initRendererI18n } from "./i18n";
import { installWindowErrorHandlers } from "./services/window-error-handler";

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

const log = createLogger("renderer-bootstrap");

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Root element not found");
}

// Initialise i18next with the boot-cached language before the first React
// render. Resources are pre-bundled, so this resolves synchronously in
// practice and prevents any translation flicker on the first paint.
initRendererI18n()
  .then(() => {
    createRoot(root).render(<App />);
  })
  .catch((err: unknown) => {
    // i18n failure is non-recoverable at this point — surface to the global
    // error safety net and still attempt to mount so the user sees something.
    log.error(`i18n initRendererI18n failed: ${(err as Error).message}`);
    createRoot(root).render(<App />);
  });
