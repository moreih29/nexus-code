import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  Server,
} from "lucide-react";
import type { FormEvent, KeyboardEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { ipcCall } from "../../../ipc/client";
import { Button } from "../../ui/button";
import {
  clampHostIndex,
  filterSshConfigHosts,
  findSshConfigHost,
  formatSshHostSummary,
  humanizeSshError,
  parseSshDestination,
  parseSshPort,
  sshHostOptionId,
} from "./ssh-helpers";
import type { SshNewConnectionViewProps } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NEW_CONN_HOST_OPTIONS_ID = "add-workspace-new-conn-host-options";
const NEW_CONN_HOST_INPUT_ID = "add-workspace-new-conn-host";
const NEW_CONN_NAME_ID = "add-workspace-new-conn-name";
const NEW_CONN_PORT_ID = "add-workspace-new-conn-port";
const NEW_CONN_IDENTITY_FILE_ID = "add-workspace-new-conn-identity-file";
const NEW_CONN_PORT_ERROR_ID = "add-workspace-new-conn-port-error";
const NEW_CONN_ADVANCED_ID = "add-workspace-new-conn-advanced";

// ---------------------------------------------------------------------------
// SshNewConnectionView — T8 implementation
//   - Host combobox (with ssh/config candidates)
//   - Name (optional)
//   - Advanced collapsible (Port + Identity file)
//   - authMode always "interactive"
//   - Connect → ssh.openBrowseSession → connectionProfile.save → onConnected
// ---------------------------------------------------------------------------

type SshConnectPhase = "idle" | "connecting" | "error";

export function SshNewConnectionView({
  onConnected,
  configHosts,
  configHostsLoading,
  onConnectPhaseChange,
  prefillProfile,
}: SshNewConnectionViewProps): React.JSX.Element {
  // Local form state — seeded from prefillProfile when present
  const [hostInput, setHostInput] = useState(() => {
    if (!prefillProfile) return "";
    return prefillProfile.user ? `${prefillProfile.user}@${prefillProfile.host}` : prefillProfile.host;
  });
  const [selectedAlias, setSelectedAlias] = useState<string | null>(null);
  const [name, setName] = useState(prefillProfile?.label ?? "");
  const [port, setPort] = useState(() => {
    if (!prefillProfile || prefillProfile.port === 22) return "";
    return String(prefillProfile.port);
  });
  const [identityFile, setIdentityFile] = useState(prefillProfile?.identityFile ?? "");
  const [advancedOpen, setAdvancedOpen] = useState(() =>
    // Open advanced if prefilled with non-default port or identity file
    !!(prefillProfile && (prefillProfile.port !== 22 || prefillProfile.identityFile)),
  );
  const [hostListOpen, setHostListOpen] = useState(false);
  const [activeHostIndex, setActiveHostIndex] = useState(-1);
  const [connectPhase, setConnectPhase] = useState<SshConnectPhase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const filteredHosts = useMemo(
    () => filterSshConfigHosts(configHosts, hostInput),
    [configHosts, hostInput],
  );
  const selectedHost = useMemo(
    () => findSshConfigHost(configHosts, hostInput, selectedAlias),
    [configHosts, hostInput, selectedAlias],
  );

  const portError =
    port.trim().length > 0 && parseSshPort(port) === null ? "Port must be 1–65535." : null;

  const parsedDest = useMemo(() => {
    if (selectedHost) return { host: selectedHost.alias, user: selectedHost.user };
    return parseSshDestination(hostInput);
  }, [selectedHost, hostInput]);

  const hostEmpty = hostInput.trim().length === 0;
  const connectDisabled =
    connectPhase === "connecting" || hostEmpty || portError !== null;

  // Sync footer primary button state
  useEffect(() => {
    onConnectPhaseChange(connectPhase, connectDisabled);
  }, [connectPhase, connectDisabled, onConnectPhaseChange]);

  useEffect(() => {
    if (!hostListOpen) return;
    setActiveHostIndex((cur) => clampHostIndex(cur, filteredHosts.length));
  }, [hostListOpen, filteredHosts.length]);

  function handleHostInputChange(value: string): void {
    setHostInput(value);
    setSelectedAlias(null);
    setErrorMessage(null);
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
    setErrorMessage(null);
  }

  function handleHostKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
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

  async function handleConnect(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (connectDisabled) return;

    const dest = parsedDest;
    if (!dest) {
      setErrorMessage("Enter a valid host or user@host.");
      return;
    }

    const parsedPort = parseSshPort(port);
    if (parsedPort === null) {
      setErrorMessage("Port must be 1–65535.");
      return;
    }

    setConnectPhase("connecting");
    setErrorMessage(null);

    try {
      const result = await ipcCall("ssh", "openBrowseSession", {
        host: dest.host,
        user: dest.user,
        port: parsedPort,
        identityFile: identityFile.trim() || undefined,
        authMode: "interactive",
      });

      // Connection succeeded → save connectionProfile
      const profileId = crypto.randomUUID();
      await ipcCall("connectionProfile", "save", {
        id: profileId,
        host: dest.host,
        user: dest.user ?? "",
        port: parsedPort,
        identityFile: identityFile.trim() || undefined,
        authMode: "interactive",
        label: name.trim() || undefined,
      });

      onConnected({
        sessionId: result.sessionId,
        initialPath: result.initialPath,
        host: dest.host,
        user: dest.user,
        port: parsedPort,
        identityFile: identityFile.trim() || undefined,
        profileId,
        connectionProfileId: profileId,
      });
    } catch (error) {
      setConnectPhase("error");
      setErrorMessage(humanizeSshError(error));
    }
  }

  const activeDescendant =
    hostListOpen && activeHostIndex >= 0
      ? sshHostOptionId(filteredHosts[activeHostIndex], activeHostIndex)
      : undefined;

  const connecting = connectPhase === "connecting";

  return (
    <form
      id="ssh-new-connection-form"
      className="flex flex-col gap-4"
      onSubmit={(e) => void handleConnect(e)}
    >
      {/* Error message */}
      {errorMessage ? (
        <div
          className="flex items-start gap-2 rounded-[--radius-control] border border-[var(--state-error-border)] bg-[var(--state-error-bg)] px-2 py-2"
          role="alert"
        >
          <AlertCircle
            className="mt-0.5 size-3.5 shrink-0 text-[var(--state-error-fg)]"
            aria-hidden="true"
          />
          <span className="min-w-0 text-app-ui-sm text-[var(--state-error-fg)]">{errorMessage}</span>
        </div>
      ) : null}

      {/* Host combobox */}
      <div className="flex flex-col gap-2">
        <label htmlFor={NEW_CONN_HOST_INPUT_ID} className="text-app-ui-sm text-foreground">
          Host
        </label>
        <div className="relative">
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
              placeholder="user@host or ~/.ssh/config alias"
              className="min-w-0 flex-1 rounded-[--radius-control] border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-50"
            />
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={hostListOpen ? "Close SSH config hosts" : "Show SSH config hosts"}
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
              className="absolute left-0 right-10 top-[calc(100%+4px)] z-10 max-h-44 overflow-y-auto rounded-[--radius-control] border border-border bg-popover p-1 text-popover-foreground"
            >
              {filteredHosts.map((host, index) => (
                <button
                  key={host.alias}
                  id={sshHostOptionId(host, index)}
                  type="button"
                  role="option"
                  aria-selected={index === activeHostIndex}
                  className="flex w-full min-w-0 flex-col rounded-[--radius-control] px-2 py-2 text-left text-app-ui-sm hover:bg-[var(--state-hover-bg)] focus-visible:bg-[var(--state-hover-bg)] focus-visible:outline-none aria-selected:bg-[var(--state-active-bg)]"
                  onClick={() => handleSelectHost(host)}
                >
                  <span className="truncate text-foreground">{host.alias}</span>
                  <span className="flex items-center gap-1 truncate text-app-ui-sm text-muted-foreground">
                    {formatSshHostSummary(host)}
                    <span className="shrink-0 rounded-[--radius-control] bg-muted px-1 text-app-micro text-muted-foreground">
                      ~/.ssh/config
                    </span>
                  </span>
                </button>
              ))}
              {configHostsLoading ? (
                <div className="px-2 py-2 text-app-ui-sm text-muted-foreground">
                  Loading SSH config…
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

      {/* Name (optional) */}
      <div className="flex flex-col gap-2">
        <label htmlFor={NEW_CONN_NAME_ID} className="text-app-ui-sm text-foreground">
          Name
          <span className="ml-1 text-app-ui-sm text-muted-foreground">(optional)</span>
        </label>
        <input
          id={NEW_CONN_NAME_ID}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          disabled={connecting}
          placeholder="e.g. Production server"
          className="w-full rounded-[--radius-control] border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-50"
        />
      </div>

      {/* Advanced collapsible */}
      <div className="rounded-[--radius-control] border border-border px-3 py-2">
        <button
          type="button"
          className="flex w-full items-center justify-between text-left text-app-ui-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-50"
          aria-expanded={advancedOpen}
          aria-controls={NEW_CONN_ADVANCED_ID}
          disabled={connecting}
          onClick={() => setAdvancedOpen((prev) => !prev)}
        >
          <span>Advanced</span>
          {advancedOpen ? (
            <ChevronDown className="size-4" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-4" aria-hidden="true" />
          )}
        </button>
        {advancedOpen ? (
          <div
            id={NEW_CONN_ADVANCED_ID}
            className="mt-3 grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]"
          >
            <div className="flex min-w-0 flex-col gap-2">
              <label htmlFor={NEW_CONN_PORT_ID} className="text-app-ui-sm text-foreground">
                Port
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
                className="w-full rounded-[--radius-control] border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-50 aria-invalid:border-[var(--state-error-border)]"
              />
              {portError ? (
                <p id={NEW_CONN_PORT_ERROR_ID} className="text-app-ui-sm text-[var(--state-error-fg)]">
                  {portError}
                </p>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <label htmlFor={NEW_CONN_IDENTITY_FILE_ID} className="text-app-ui-sm text-foreground">
                Identity file
              </label>
              <input
                id={NEW_CONN_IDENTITY_FILE_ID}
                value={identityFile}
                onChange={(e) => setIdentityFile(e.currentTarget.value)}
                disabled={connecting}
                placeholder="~/.ssh/id_ed25519"
                className="w-full rounded-[--radius-control] border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-50"
              />
            </div>
          </div>
        ) : null}
      </div>

      {/* Hidden submit trigger for footer primary button */}
      <button type="submit" aria-hidden="true" tabIndex={-1} className="sr-only">
        Connect
      </button>
    </form>
  );
}

// Re-export for footer button rendering in root dialog
export { Server };
