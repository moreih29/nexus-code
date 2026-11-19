import { appErrorBug, appErrorCancelled, appErrorFailed } from "../../../shared/error/app-error";
import { chatSendErrorKind } from "../../services/chat/store";
import { surfaceError } from "../../services/error-surface/surface-error";

/** Reports send and approval failures without exposing transport details. */
export function surfaceChatSendError(error: unknown): void {
  const code = chatSendErrorKind(error);
  const message = error instanceof Error ? error.message : String(error);
  const appError =
    code === "cancelled"
      ? appErrorCancelled(message, { code })
      : code === "chat.send-failed"
        ? appErrorBug(message, { code })
        : appErrorFailed(message, { code });
  surfaceError(appError, { surface: "toast" });
}
