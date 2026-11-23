import i18next from "i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { FormEvent, KeyboardEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isImeComposing } from "@/utils/ime";
import { appErrorInvalidInput } from "../../../../shared/error/app-error";
import { ipcErrorToAppError } from "../../../../shared/ipc/result";
import { useIpcAction } from "../../../hooks/use-ipc-action";
import { surfaceError } from "../../../services/error-surface/surface-error";
import {
  closeSshBrowseSession,
  openSshBrowseSession,
  saveConnectionProfileResult,
} from "../../../services/workspace";
import { Button } from "../../ui/button";
import { showToast } from "../../ui/toast";
import { BootstrapProgressBar } from "../bootstrap-progress-bar";
import { ErrorNotice } from "./error-notice";
import {
  clampHostIndex,
  filterSshConfigHosts,
  findSshConfigHost,
  formatSshHostSummary,
  parseSshDestination,
  parseSshPort,
  sshHostOptionId,
} from "./ssh-helpers";
import type { SshNewConnectionViewProps } from "./types";
import { useBrowseProgress } from "./use-browse-progress";

const NEW_CONN_HOST_OPTIONS_ID = "add-workspace-new-conn-host-options";
const NEW_CONN_HOST_INPUT_ID = "add-workspace-new-conn-host";
const NEW_CONN_NAME_ID = "add-workspace-new-conn-name";
const NEW_CONN_PORT_ID = "add-workspace-new-conn-port";
const NEW_CONN_IDENTITY_FILE_ID = "add-workspace-new-conn-identity-file";
const NEW_CONN_PORT_ERROR_ID = "add-workspace-new-conn-port-error";
const NEW_CONN_ADVANCED_ID = "add-workspace-new-conn-advanced";

function showSaveFailedToast(onRetrySave: () => void): void {
  showToast({
    kind: "error",
    message: i18next.t("ssh.save_failed_toast"),
    actions: [{ label: i18next.t("action.retry_save"), onAction: onRetrySave }],
  });
}

export function SshNewConnectionView({
  onConnected,
  cancelConnectRef,
  configHosts,
  configHostsLoading,
  onConnectPhaseChange,
  prefillProfile,
}: SshNewConnectionViewProps): React.JSX.Element {
  const { t } = useTranslation();
  const [hostInput, setHostInput] = useState(() => {
    if (!prefillProfile) return "";
    return prefillProfile.user
      ? `${prefillProfile.user}@${prefillProfile.host}`
      : prefillProfile.host;
  });
  const [selectedAlias, setSelectedAlias] = useState<string | null>(null);
  const [name, setName] = useState(prefillProfile?.label ?? "");
  const [port, setPort] = useState(() => {
    if (!prefillProfile || prefillProfile.port === 22) return "";
    return String(prefillProfile.port);
  });
  const [identityFile, setIdentityFile] = useState(prefillProfile?.identityFile ?? "");
  const [advancedOpen, setAdvancedOpen] = useState(
    () => !!(prefillProfile && (prefillProfile.port !== 22 || prefillProfile.identityFile)),
  );
  const [hostListOpen, setHostListOpen] = useState(false);
  const [activeHostIndex, setActiveHostIndex] = useState(-1);

  const hostComboboxRef = useRef<HTMLDivElement>(null);

  const { state: connectState, run: runConnect, cancel, isPending } = useIpcAction<void>();
  useEffect(() => {
    if (!cancelConnectRef) return;
    cancelConnectRef.current = cancel;
    return () => {
      if (cancelConnectRef.current === cancel) cancelConnectRef.current = null;
    };
  }, [cancelConnectRef, cancel]);

  const {
    progress: browseProgress,
    begin: beginProgress,
    clear: clearProgress,
  } = useBrowseProgress();

  const connectPhase =
    connectState.status === "loading"
      ? "connecting"
      : connectState.status === "error"
        ? "error"
        : "idle";

  const filteredHosts = useMemo(
    () => filterSshConfigHosts(configHosts, hostInput),
    [configHosts, hostInput],
  );
  const selectedHost = useMemo(
    () => findSshConfigHost(configHosts, hostInput, selectedAlias),
    [configHosts, hostInput, selectedAlias],
  );

  const portError =
    port.trim().length > 0 && parseSshPort(port) === null ? t("ssh.port_error") : null;

  const parsedDest = useMemo(() => {
    if (selectedHost) return { host: selectedHost.alias, user: selectedHost.user };
    return parseSshDestination(hostInput);
  }, [selectedHost, hostInput]);

  const hostEmpty = hostInput.trim().length === 0;

  const connectDisabled = isPending || hostEmpty || portError !== null;

  useEffect(() => {
    onConnectPhaseChange(connectPhase, connectDisabled);
  }, [connectPhase, connectDisabled, onConnectPhaseChange]);

  useEffect(() => {
    if (connectPhase !== "connecting") clearProgress();
  }, [connectPhase, clearProgress]);

  useEffect(() => {
    if (!hostListOpen) return;
    setActiveHostIndex((cur) => clampHostIndex(cur, filteredHosts.length));
  }, [hostListOpen, filteredHosts.length]);

  useEffect(() => {
    if (!hostListOpen) return;

    function handlePointerDown(event: PointerEvent): void {
      if (hostComboboxRef.current && !hostComboboxRef.current.contains(event.target as Node)) {
        setHostListOpen(false);
        setActiveHostIndex(-1);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [hostListOpen]);

  function handleHostInputChange(value: string): void {
    setHostInput(value);
    setSelectedAlias(null);
    setHostListOpen(true);
    setActiveHostIndex(filteredHosts.length > 0 ? 0 : -1);
  }

  function handleSelectHost(host: (typeof filteredHosts)[number]): void {
    setHostInput(host.alias);
    setSelectedAlias(host.alias);
    setPort(host.port ? String(host.port) : "");
    setIdentityFile(host.identityFile ?? "");
    setHostListOpen(false);
    setActiveHostIndex(-1);
  }

  function handleHostKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (isImeComposing(event)) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filteredHosts.length === 0) return;
      setHostListOpen(true);
      setActiveHostIndex((cur) => (cur + 1) % filteredHosts.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filteredHosts.length === 0) return;
      setHostListOpen(true);
      setActiveHostIndex((cur) => (cur <= 0 ? filteredHosts.length - 1 : cur - 1));
      return;
    }
    if (event.key === "Enter" && hostListOpen && activeHostIndex >= 0) {
      const host = filteredHosts[activeHostIndex];
      if (!host) return;
      event.preventDefault();
      handleSelectHost(host);
      return;
    }
    if (event.key === "Escape" && hostListOpen) {
      event.preventDefault();
      setHostListOpen(false);
      setActiveHostIndex(-1);
    }
  }

  function handleConnect(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (connectDisabled) return;

    const dest = parsedDest;
    if (!dest) {
      runConnect(async () => {
        throw appErrorInvalidInput("Invalid SSH destination", {
          domain: "ssh",
          code: "invalid-host",
        });
      });
      return;
    }

    const parsedPort = parseSshPort(port);
    if (parsedPort === null) {
      return;
    }

    const capturedDest = dest;
    const capturedPort = parsedPort;
    const capturedIdentityFile = identityFile.trim() || undefined;
    const capturedName = name.trim() || undefined;
    const profileId = crypto.randomUUID();

    runConnect(async (signal) => {
      const result = await openSshBrowseSession({
        host: capturedDest.host,
        user: capturedDest.user,
        port: capturedPort,
        identityFile: capturedIdentityFile,
        authMode: "interactive",
        progressId: beginProgress(),
      });

      if (!result.ok) throw ipcErrorToAppError(result);

      const connectedUser = result.value.user;
      const sessionId = result.value.sessionId;
      const initialPath = result.value.initialPath;

      let owned = true;
      const release = (): void => {
        if (!owned) return;
        owned = false;
        void closeSshBrowseSession(sessionId);
      };
      if (signal.aborted) {
        release();
        return;
      }
      signal.addEventListener("abort", release, { once: true });
      try {
        const saveResult = await saveConnectionProfileResult({
          id: profileId,
          host: capturedDest.host,
          user: connectedUser,
          port: capturedPort,
          identityFile: capturedIdentityFile,
          authMode: "interactive",
          label: capturedName,
        });

        if (signal.aborted) return;
        if (!saveResult.ok) {
          const retrySave = (): void => {
            void saveConnectionProfileResult({
              id: profileId,
              host: capturedDest.host,
              user: connectedUser,
              port: capturedPort,
              identityFile: capturedIdentityFile,
              authMode: "interactive",
              label: capturedName,
            }).then((retryResult) => {
              if (!retryResult.ok) {
                showSaveFailedToast(retrySave);
              }
            });
          };

          showSaveFailedToast(retrySave);
        }

        onConnected({
          sessionId,
          initialPath,
          host: capturedDest.host,
          user: connectedUser,
          port: capturedPort,
          identityFile: capturedIdentityFile,
          profileId,
          connectionProfileId: profileId,
        });
        owned = false;
      } finally {
        signal.removeEventListener("abort", release);
        release();
      }
    });
  }

  const activeDescendant =
    hostListOpen && activeHostIndex >= 0
      ? sshHostOptionId(filteredHosts[activeHostIndex], activeHostIndex)
      : undefined;

  const connecting = connectState.status === "loading";

  const [inlineError, setInlineError] = useState<string | null>(null);
  useEffect(() => {
    if (connectState.status !== "error") {
      setInlineError(null);
      return;
    }
    const surface = surfaceError(connectState.error, { surface: "inline" });
    setInlineError(surface.surface === "inline" ? surface.userMessage : null);
  }, [connectState]);

  return (
    <form
      id="ssh-new-connection-form"
      className="flex flex-col gap-4"
      onSubmit={(e) => handleConnect(e)}
    >
      {inlineError ? <ErrorNotice message={inlineError} className="px-2 py-2" /> : null}

      {connecting && browseProgress ? (
        <BootstrapProgressBar
          phase={browseProgress.phase}
          name={browseProgress.name}
          bytesDone={browseProgress.bytesDone}
          bytesTotal={browseProgress.bytesTotal}
          className="px-2"
        />
      ) : null}

      <div className="flex flex-col gap-2">
        <label htmlFor={NEW_CONN_HOST_INPUT_ID} className="text-app-ui-sm text-foreground">
          {t("ssh.label_host")}
        </label>
        <div className="relative" ref={hostComboboxRef}>
          <div className="flex items-center gap-2">
            <input
              id={NEW_CONN_HOST_INPUT_ID}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={hostListOpen}
              aria-controls={NEW_CONN_HOST_OPTIONS_ID}
              aria-activedescendant={activeDescendant}
              value={hostInput}
              onChange={(e) => handleHostInputChange(e.currentTarget.value)}
              onFocus={() => {
                if (filteredHosts.length > 0) setHostListOpen(true);
              }}
              onKeyDown={handleHostKeyDown}
              disabled={connecting}
              placeholder={t("ssh.host_placeholder")}
              className="min-w-0 flex-1 rounded-(--radius-control) border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-50"
            />
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={hostListOpen ? t("ssh.host_close_aria") : t("ssh.host_show_aria")}
              aria-expanded={hostListOpen}
              disabled={connecting || configHosts.length === 0}
              onClick={() => setHostListOpen((prev) => !prev)}
            >
              <ChevronDown className="size-4" aria-hidden="true" />
            </Button>
          </div>

          {hostListOpen && filteredHosts.length > 0 ? (
            <div
              id={NEW_CONN_HOST_OPTIONS_ID}
              role="listbox"
              className="absolute left-0 right-10 top-[calc(100%+4px)] z-10 max-h-44 overflow-y-auto floating-panel p-1"
            >
              {filteredHosts.map((host, index) => (
                <button
                  key={host.alias}
                  id={sshHostOptionId(host, index)}
                  type="button"
                  role="option"
                  aria-selected={index === activeHostIndex}
                  className="flex w-full min-w-0 flex-col rounded-(--radius-control) px-2 py-2 text-left text-app-ui-sm hover:bg-[var(--state-hover-bg)] focus-visible:bg-[var(--state-hover-bg)] focus-visible:outline-none aria-selected:bg-[var(--state-active-bg)]"
                  onClick={() => handleSelectHost(host)}
                >
                  <span className="truncate text-foreground">{host.alias}</span>
                  <span className="flex items-center gap-1 truncate text-app-ui-sm text-muted-foreground">
                    {formatSshHostSummary(host)}
                    <span className="shrink-0 rounded-(--radius-control) bg-muted px-1 text-app-micro text-muted-foreground">
                      ~/.ssh/config
                    </span>
                  </span>
                </button>
              ))}
              {configHostsLoading ? (
                <div className="px-2 py-2 text-app-ui-sm text-muted-foreground">
                  {t("ssh.loading_config")}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {selectedHost ? (
          <p className="text-app-ui-sm text-muted-foreground">
            {formatSshHostSummary(selectedHost)}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={NEW_CONN_NAME_ID} className="text-app-ui-sm text-foreground">
          {t("ssh.label_name")}
          <span className="ml-1 text-app-ui-sm text-muted-foreground">
            {t("ssh.label_name_optional")}
          </span>
        </label>
        <input
          id={NEW_CONN_NAME_ID}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          disabled={connecting}
          placeholder={t("ssh.name_placeholder")}
          className="w-full rounded-(--radius-control) border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-50"
        />
      </div>

      <div className="rounded-(--radius-control) border border-border px-3 py-2">
        <button
          type="button"
          className="flex w-full items-center gap-1.5 text-left text-app-ui-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-50"
          aria-expanded={advancedOpen}
          aria-controls={NEW_CONN_ADVANCED_ID}
          disabled={connecting}
          onClick={() => setAdvancedOpen((prev) => !prev)}
        >
          {advancedOpen ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <span>{t("ssh.label_advanced")}</span>
        </button>
        {advancedOpen ? (
          <div
            id={NEW_CONN_ADVANCED_ID}
            className="mt-3 grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]"
          >
            <div className="flex min-w-0 flex-col gap-2">
              <label htmlFor={NEW_CONN_PORT_ID} className="text-app-ui-sm text-foreground">
                {t("ssh.label_port")}
              </label>
              <input
                id={NEW_CONN_PORT_ID}
                type="text"
                inputMode="numeric"
                value={port}
                onChange={(e) => setPort(e.currentTarget.value)}
                disabled={connecting}
                aria-invalid={portError ? true : undefined}
                aria-describedby={portError ? NEW_CONN_PORT_ERROR_ID : undefined}
                placeholder="22"
                className="w-full rounded-(--radius-control) border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-50 aria-invalid:border-[var(--state-error-border)]"
              />
              {portError ? (
                <p
                  id={NEW_CONN_PORT_ERROR_ID}
                  className="text-app-ui-sm text-[var(--state-error-fg)]"
                >
                  {portError}
                </p>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <label htmlFor={NEW_CONN_IDENTITY_FILE_ID} className="text-app-ui-sm text-foreground">
                {t("ssh.label_identity_file")}
              </label>
              <input
                id={NEW_CONN_IDENTITY_FILE_ID}
                value={identityFile}
                onChange={(e) => setIdentityFile(e.currentTarget.value)}
                disabled={connecting}
                placeholder="~/.ssh/id_ed25519"
                className="w-full rounded-(--radius-control) border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-50"
              />
            </div>
          </div>
        ) : null}
      </div>

      <button type="submit" aria-hidden="true" tabIndex={-1} className="sr-only">
        Connect
      </button>
    </form>
  );
}
