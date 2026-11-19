import { ChevronRight, LoaderCircle, SquareTerminal } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipcErrorToAppError } from "../../../../shared/ipc/result";
import { useIpcAction } from "../../../hooks/use-ipc-action";
import { surfaceError } from "../../../services/error-surface/surface-error";
import {
  closeSshBrowseSession,
  listWslDistros,
  openWslBrowseSession,
} from "../../../services/workspace";
import { EmptyState } from "../../ui/empty-state";
import { Skeleton, SkeletonLine } from "../../ui/skeleton";
import { BootstrapProgressBar } from "../bootstrap-progress-bar";
import { ErrorNotice } from "./error-notice";
import type { WslDistroListViewProps } from "./types";
import { useBrowseProgress } from "./use-browse-progress";

// ---------------------------------------------------------------------------
// WslDistroListView — the WSL distributions to open a folder in
// ---------------------------------------------------------------------------

/**
 * Lists the installed WSL distributions. Choosing one starts the agent in it
 * (installing it there first if needed) and moves on to the directory picker.
 */
export function WslDistroListView({ onConnected }: WslDistroListViewProps): React.JSX.Element {
  const { t } = useTranslation();
  const [distros, setDistros] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const { state, run, isPending } = useIpcAction<void>();
  const connecting = isPending ? selected : null;
  const { progress, begin: beginProgress, clear: clearProgress } = useBrowseProgress();

  useEffect(() => {
    let cancelled = false;
    listWslDistros()
      .catch(() => [])
      .then((list) => {
        if (!cancelled) setDistros(list);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (state.status !== "error") return;
    const surface = surfaceError(state.error, { surface: "inline" });
    if (surface.surface === "inline") setErrorMessage(surface.userMessage);
  }, [state]);

  /** Starts one distribution and surfaces any failed attempt beside its row. */
  function connect(distro: string): void {
    if (isPending) return;
    setSelected(distro);
    setErrorMessage(null);
    run(async (signal) => {
      try {
        const result = await openWslBrowseSession(distro, beginProgress(), signal);
        if (!result.ok) throw ipcErrorToAppError(result);
        if (signal.aborted) {
          void closeSshBrowseSession(result.value.sessionId);
          return;
        }
        onConnected({ ...result.value, distro });
      } finally {
        clearProgress();
      }
    });
  }

  if (distros === null) {
    return (
      <Skeleton label={t("wsl.loading")} className="gap-1 px-0 py-0">
        {(["sk-0", "sk-1"] as const).map((k) => (
          <SkeletonLine key={k} className="h-10 w-full" />
        ))}
      </Skeleton>
    );
  }

  if (distros.length === 0) {
    return (
      <EmptyState
        tone="status"
        icon={<SquareTerminal className="size-6" aria-hidden="true" />}
        title={t("wsl.none")}
        description={t("wsl.none_desc")}
        className="py-6"
      />
    );
  }

  return (
    <ul className="flex flex-col gap-0.5" aria-label={t("wsl.distributions")}>
      {distros.map((distro) => {
        const isConnecting = connecting === distro;
        const rowError = selected === distro ? errorMessage : null;
        return (
          <li key={distro}>
            <button
              type="button"
              disabled={connecting !== null}
              onClick={() => void connect(distro)}
              className={[
                "flex w-full items-center gap-3 rounded-(--radius-control) px-2 py-2 text-left outline-none",
                "hover:bg-[var(--state-hover-bg)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                connecting !== null && !isConnecting ? "opacity-50" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {isConnecting ? (
                <LoaderCircle
                  className="size-4 shrink-0 animate-spin text-[var(--state-loading-indicator)]"
                  aria-hidden="true"
                />
              ) : (
                <SquareTerminal
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-app-ui-sm text-foreground">{distro}</span>
                {isConnecting ? (
                  progress ? (
                    <BootstrapProgressBar
                      phase={progress.phase}
                      name={progress.name}
                      bytesDone={progress.bytesDone}
                      bytesTotal={progress.bytesTotal}
                      className="mt-1"
                    />
                  ) : (
                    <span className="block truncate text-app-ui-sm text-muted-foreground">
                      {t("wsl.starting")}
                    </span>
                  )
                ) : null}
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
            {rowError ? (
              <ErrorNotice
                message={rowError}
                className="mx-2 mb-1 px-2 py-1.5"
                textClass="text-app-micro"
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
