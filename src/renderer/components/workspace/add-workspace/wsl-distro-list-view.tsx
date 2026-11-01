import { ChevronRight, LoaderCircle, SquareTerminal } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listWslDistros, openWslBrowseSession } from "../../../services/workspace";
import { BootstrapProgressBar } from "../bootstrap-progress-bar";
import { EmptyState } from "../../ui/empty-state";
import { Skeleton, SkeletonLine } from "../../ui/skeleton";
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
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<{ distro: string; message: string } | null>(null);
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

  async function connect(distro: string): Promise<void> {
    if (connecting) return;
    setConnecting(distro);
    setError(null);
    try {
      const session = await openWslBrowseSession(distro, beginProgress());
      onConnected({ ...session, distro });
    } catch (err) {
      setError({ distro, message: err instanceof Error ? err.message : String(err) });
    } finally {
      clearProgress();
      setConnecting(null);
    }
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
        const errorMessage = error?.distro === distro ? error.message : null;
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
            {errorMessage ? (
              <ErrorNotice
                message={errorMessage}
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
