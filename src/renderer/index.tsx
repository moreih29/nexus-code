import "./zod-config";
import "./services/editor/runtime/monaco-loader";
import { createRoot } from "react-dom/client";
import { createLogger } from "../shared/log/renderer";
import { App } from "./app";
import { initRendererI18n } from "./i18n";
import { installCspViolationLogger } from "./services/csp-violation-logger";
import { installUnsavedChangesUnloadGuard } from "./services/editor/save/unsaved-guard";
import { installWindowErrorHandlers } from "./services/window-error-handler";
import { installLayoutClosePersistence } from "./state/persistence";

installWindowErrorHandlers();
installCspViolationLogger();
installUnsavedChangesUnloadGuard();
installLayoutClosePersistence();

const log = createLogger("renderer-bootstrap");

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Root element not found");
}

initRendererI18n()
  .then(() => {
    createRoot(root).render(<App />);
  })
  .catch((err: unknown) => {
    log.error(`i18n initRendererI18n failed: ${(err as Error).message}`);
    createRoot(root).render(<App />);
  });
