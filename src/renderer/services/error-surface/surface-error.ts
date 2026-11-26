import i18next from "i18next";
import { ATTACH_FOLDER_LINK } from "../../../shared/chat/attach-errors";
import type { AppError } from "../../../shared/error/app-error";
import { createLogger } from "../../../shared/log/renderer";
import { showToast } from "../../components/ui/toast";
import { copyText } from "../../utils/clipboard";
import { knownFsErrorMessage } from "../../utils/error-classification";

const log = createLogger("renderer");

export type ErrorSurface = "inline" | "banner" | "toast" | "specific-toast" | "auto";

export interface InlineSurfaceResult {
  readonly surface: "inline";
  readonly userMessage: string;
}

export interface BannerSurfaceResult {
  readonly surface: "banner";
  readonly userMessage: string;
  readonly onRetry?: () => void;
}

export interface SilentSurfaceResult {
  readonly surface: "silent";
}

export interface ToastSurfaceResult {
  readonly surface: "toast";
}

export type SurfaceErrorResult =
  | InlineSurfaceResult
  | BannerSurfaceResult
  | ToastSurfaceResult
  | SilentSurfaceResult;

export interface SurfaceErrorOptions {
  surface: ErrorSurface;
  onRetry?: () => void;
}

function buildInvalidInputMessage(error: AppError): string {
  if (error.domain === "ssh" && error.code === "invalid-host")
    return i18next.t("common:ssh.invalid_host");
  if (error.domain === "fs" && error.code) {
    return knownFsErrorMessage(error.code) ?? i18next.t("errors:generic.invalid-input");
  }
  return i18next.t("errors:generic.invalid-input");
}

function buildSpecificFailedMessage(error: AppError): string | undefined {
  if (error.code === "terminal-input-failed") return i18next.t("errors:terminal.inputFailed");
  if (error.code === "terminal-input-queue-full")
    return i18next.t("errors:terminal.inputQueueFull");
  if (error.code === "clipboard-write-failed") return i18next.t("errors:clipboard.writeFailed");
  if (error.code === ATTACH_FOLDER_LINK) return i18next.t("errors:chat.attachFolderLink");
  if (error.domain === "fs" && error.code) {
    return knownFsErrorMessage(error.code);
  }
  if (error.domain === "git" && error.code) {
    return gitCodeToUserMessage(error.code);
  }
  if (error.domain === "ssh") {
    return sshCodeToUserMessage(error.code);
  }
  return undefined;
}

function sshCodeToUserMessage(code: string | undefined): string {
  switch (code) {
    case "ssh.connect-failed":
      return i18next.t("common:ssh.error.connect_failed");
    case "ssh.auth-failed":
      return i18next.t("common:ssh.error.auth_failed");
    case "ssh.session-expired":
      return i18next.t("common:ssh.error.session_expired");
    case "ssh.path-not-found":
      return i18next.t("common:ssh.error.path_not_found");
    case "server.spawn-failed":
      return i18next.t("common:ssh.error.spawn_failed");
    case "server.protocol-version-mismatch":
      return i18next.t("common:ssh.error.protocol_version_mismatch");
    case "server.protocol-error":
      return i18next.t("common:ssh.error.protocol_error");
    case "transport.unknown":
    case "ssh.unknown":
      return i18next.t("common:ssh.error.ssh_unknown");
    default:
      return i18next.t("common:ssh.error.connection_failed");
  }
}

function gitCodeToUserMessage(code: string): string | undefined {
  switch (code) {
    case "not-repo":
      return i18next.t("errors:git.not-repo");
    case "auth":
      return i18next.t("errors:git.auth");
    case "no-upstream":
      return i18next.t("errors:git.no-upstream");
    case "conflict":
      return i18next.t("errors:git.conflict");
    default:
      return undefined;
  }
}

function buildInternalMessage(error: AppError): string {
  const parts: string[] = [
    `[${error.category}]`,
    error.domain ? `domain=${error.domain}` : null,
    error.code ? `code=${error.code}` : null,
    error.correlationId ? `correlationId=${error.correlationId}` : null,
    `message=${error.message}`,
  ].filter(Boolean) as string[];
  return parts.join(" ");
}

function buildBugClipboardDetail(error: AppError): string {
  const lines: string[] = [
    `Category: ${error.category}`,
    error.domain ? `Domain: ${error.domain}` : null,
    error.code ? `Code: ${error.code}` : null,
    `Message: ${error.message}`,
    error.correlationId ? `CorrelationId: ${error.correlationId}` : null,
  ].filter(Boolean) as string[];
  return lines.join("\n");
}

export function surfaceError(error: AppError, options: SurfaceErrorOptions): SurfaceErrorResult {
  const { surface, onRetry } = options;

  switch (error.category) {
    case "cancelled":
      return { surface: "silent" };

    case "invalid-input":
      return routeInvalidInput(error, surface);

    case "failed":
      return routeFailed(error, surface, onRetry);

    case "bug":
      return routeBug(error, surface);
  }
}

function routeInvalidInput(error: AppError, surface: ErrorSurface): SurfaceErrorResult {
  const userMessage = buildInvalidInputMessage(error);

  if (surface === "toast" || surface === "specific-toast" || surface === "banner") {
    log.warn(
      `surfaceError: invalid-input routed to inline (requested '${surface}' is illegal for this category). ${buildInternalMessage(error)}`,
    );
  }

  return { surface: "inline", userMessage };
}

function routeFailed(
  error: AppError,
  surface: ErrorSurface,
  onRetry?: () => void,
): SurfaceErrorResult {
  const internalMessage = buildInternalMessage(error);

  log.warn(`surfaceError: failed — ${internalMessage}`, {
    correlationId: error.correlationId,
  });

  const specific = buildSpecificFailedMessage(error);
  if (surface === "specific-toast" && specific === undefined) return { surface: "silent" };
  const userMessage = specific ?? i18next.t("errors:generic.failed");

  if (surface === "inline") {
    return { surface: "inline", userMessage };
  }

  if (surface === "banner") {
    return { surface: "banner", userMessage, onRetry };
  }

  const actions = onRetry ? [{ label: i18next.t("common:action.retry"), onAction: onRetry }] : [];
  showToast(
    { kind: "error", message: userMessage, actions },
    { reflowOnDuplicate: surface === "specific-toast" },
  );
  return { surface: "toast" };
}

function routeBug(error: AppError, surface: ErrorSurface): SurfaceErrorResult {
  const internalMessage = buildInternalMessage(error);

  log.error(`surfaceError: bug — ${internalMessage}`, {
    correlationId: error.correlationId,
  });

  if (surface === "specific-toast") return { surface: "silent" };
  if (surface === "inline" || surface === "banner") {
    log.warn(
      `surfaceError: bug demoted to toast (requested '${surface}' is illegal for bug category)`,
    );
  }

  const clipboardDetail = buildBugClipboardDetail(error);

  showToast({
    kind: "error",
    message: i18next.t("errors:generic.bug"),
    actions: [
      {
        label: i18next.t("common:action.copy_details"),
        dedupeKey: clipboardDetail,
        onAction: () => copyText(clipboardDetail),
      },
      {
        label: i18next.t("common:action.open_log"),
        onAction: openLogsFolder,
      },
    ],
  });

  return { surface: "toast" };
}

function openLogsFolder(): void {
  import("../../ipc/client")
    .then(({ ipcCallResult }) => {
      void ipcCallResult("system", "openLogsFolder", undefined);
    })
    .catch(() => {});
}
