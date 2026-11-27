import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/ui/empty-state";
import type { BrowserRuntimeState } from "@/state/stores/browser-runtime";

type LoadFailure = NonNullable<BrowserRuntimeState["loadFailure"]>;

const networkReasons: Readonly<Partial<Record<number, string>>> = {
  [-7]: "timeout",
  [-102]: "connection_refused",
  [-105]: "name_not_resolved",
  [-106]: "offline",
  [-118]: "timeout",
  [-137]: "name_not_resolved",
};

const otherReasons: Readonly<Partial<Record<string, string>>> = {
  ERR_DISALLOWED_URL_SCHEME: "blocked_address",
  ERR_SSH_NOT_CONNECTED: "ssh_not_connected",
  ERR_PORT_FORWARD_FAILED: "port_forward_failed",
};

function failureReason({ code, description }: LoadFailure): string {
  if (description.startsWith("ERR_CERT") || (code !== undefined && code <= -200 && code > -220)) {
    return "certificate";
  }
  return (
    (code === undefined ? undefined : networkReasons[code]) ??
    otherReasons[description] ??
    "unknown"
  );
}

function displayAddress(address: string): string {
  const url = URL.parse(address);
  return url?.host || url?.pathname || address;
}

export function BrowserLoadError({
  failure,
  isLoading,
  onRetry,
}: {
  failure: LoadFailure;
  isLoading: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const stopped = failure.description === "ERR_RENDER_PROCESS_GONE";
  const address = displayAddress(failure.url);
  const detail = stopped
    ? address
    : [address, t(`browser.load_error.${failureReason(failure)}`, { error: failure.description })]
        .filter(Boolean)
        .join(" · ");

  return (
    <div className="absolute inset-0 flex overflow-auto" role="status">
      <EmptyState
        title={t(stopped ? "browser.page_stopped" : "browser.load_failed")}
        description={detail}
        actionLabel={t(
          isLoading ? "browser.retrying" : stopped ? "browser.reload_page" : "action.retry",
        )}
        onAction={onRetry}
        disabled={isLoading}
        tone="status"
        className="[overflow-wrap:anywhere]"
      />
    </div>
  );
}
