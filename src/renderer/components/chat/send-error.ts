import { appErrorBug, appErrorCancelled, appErrorFailed } from "../../../shared/error/app-error";
import { chatSendErrorKind } from "../../services/chat/transport/queue";
import { surfaceError } from "../../services/error-surface/surface-error";

export function surfaceChatSendError(error: unknown, draft?: "restored" | "retained"): void {
  const code = chatSendErrorKind(error);
  const message = error instanceof Error ? error.message : String(error);
  const appError =
    code === "cancelled"
      ? appErrorCancelled(message, { code })
      : code === "chat.send-failed"
        ? appErrorBug(message, { code })
        : appErrorFailed(message, { code });
  surfaceError(appError, { surface: draft ? "specific-toast" : "toast" });
}
