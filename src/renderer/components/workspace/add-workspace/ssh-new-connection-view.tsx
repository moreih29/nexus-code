import { AlertCircle, ChevronDown, ChevronRight } from "lucide-react";
import i18next from "i18next";
import type { FormEvent, KeyboardEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { appErrorCancelled, appErrorFailed } from "../../../../shared/error/app-error";
import { useIpcAction } from "../../../hooks/use-ipc-action";
import { showToast } from "../../ui/toast";
import { openSshBrowseSession, saveConnectionProfileResult } from "../../../services/workspace";
import { Button } from "../../ui/button";
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
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Show a non-blocking warning toast for a failed connection-profile save.
 *
 * The connection succeeded (primary effect) so the workspace flow continues
 * uninterrupted. This toast informs the user that the profile was not saved
 * for next time and offers a "Retry save" button that replays only the
 * secondary save step — never re-connects or re-authenticates.
 *
 * Action toasts use role="alert" and never auto-dismiss (per toast.tsx contract),
 * so the user can act on "Retry save" at their convenience without time pressure.
 */
function showSaveFailedToast(onRetrySave: () => void): void {
  showToast({
    kind: "error",
    message: i18next.t("ssh.save_failed_toast"),
    actions: [{ label: i18next.t("action.retry_save"), onAction: onRetrySave }],
  });
}

// ---------------------------------------------------------------------------
// SshNewConnectionView — T10 implementation
//   - Host combobox (with ssh/config candidates)
//   - Name (optional)
//   - Advanced collapsible (Port + Identity file)
//   - authMode always "interactive"
//   - Connect → ssh.openBrowseSession (primary) → connectionProfile.save (secondary)
//     Partial-failure policy (plan issue-8):
//       • Primary success + secondary failure → complete the workspace flow and
//         show a non-blocking toast with "Retry save" (secondary-only retry).
//       • Primary failure → inline error, form stays open for retry.
//       • Cancellation (IPC "cancelled") → silent, no banner.
//   - useIpcAction manages the loading lifecycle; "Connecting…" freeze is
//     structurally impossible because the hook's try/catch/finally guarantees
//     state always exits 'loading' on any branch.
// ---------------------------------------------------------------------------

export function SshNewConnectionView({
  onConnected,
  configHosts,
  configHostsLoading,
  onConnectPhaseChange,
  prefillProfile,
}: SshNewConnectionViewProps): React.JSX.Element {
  const { t } = useTranslation();
  // Local form state — seeded from prefillProfile when present
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
    () =>
      // Open advanced if prefilled with non-default port or identity file
      !!(prefillProfile && (prefillProfile.port !== 22 || prefillProfile.identityFile)),
  );
  const [hostListOpen, setHostListOpen] = useState(false);
  const [activeHostIndex, setActiveHostIndex] = useState(-1);

  // Ref for the host combobox wrapper (input + toggle button + listbox).
  // Used to detect clicks outside the dropdown and close it.
  const hostComboboxRef = useRef<HTMLDivElement>(null);

  // ---------------------------------------------------------------------------
  // useIpcAction — unified loading lifecycle for the two-stage connect flow.
  //
  // The hook's try/catch/finally guarantees that 'loading' always resolves to
  // 'success', 'error', or 'idle' (cancel), so "Connecting…" can never freeze
  // regardless of which await fails or when the component unmounts.
  // ---------------------------------------------------------------------------
  const { state: connectState, run: runConnect, isPending } = useIpcAction<void>();

  // Map useIpcAction discriminated-union state to the parent's connectPhase API.
  // The parent footer uses these to drive button label and disabled state.
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

  // connectDisabled: block submit while pending, when host is empty, or when port is invalid.
  const connectDisabled = isPending || hostEmpty || portError !== null;

  // Sync footer primary button state to parent on every relevant change.
  useEffect(() => {
    onConnectPhaseChange(connectPhase, connectDisabled);
  }, [connectPhase, connectDisabled, onConnectPhaseChange]);

  useEffect(() => {
    if (!hostListOpen) return;
    setActiveHostIndex((cur) => clampHostIndex(cur, filteredHosts.length));
  }, [hostListOpen, filteredHosts.length]);

  // Close the host dropdown when the user clicks outside the combobox wrapper.
  // Listener is only active while the dropdown is open to minimise overhead.
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

  // ---------------------------------------------------------------------------
  // handleConnect — two-stage action routed through useIpcAction.run()
  //
  // Stage 1 (primary): openSshBrowseSession — establishes the SSH session.
  //   • Failure (including auth cancellation) → the hook branches automatically:
  //     - "cancelled" kind → hook state returns to 'idle', no UI surface.
  //     - Other errors    → hook state = 'error', inline banner rendered below.
  //
  // Stage 2 (secondary): saveConnectionProfileResult — persists the profile.
  //   • Partial-failure policy (plan issue-8): the connection already succeeded,
  //     so we MUST call onConnected regardless of whether the save succeeds.
  //     A failed save triggers a non-blocking warning toast + "Retry save" action.
  //     The "Retry save" callback re-runs the save only — never re-connects.
  //   • The run() callback always returns void; the hook reaches 'success' in
  //     both the save-ok and save-fail paths, ensuring loading clears in all cases.
  // ---------------------------------------------------------------------------
  function handleConnect(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (connectDisabled) return;

    const dest = parsedDest;
    if (!dest) {
      // Form-level validation: host field is required and already non-empty
      // (connectDisabled blocks the submit when hostEmpty is true).  This guard
      // defends against the edge where parseSshDestination returns null despite
      // a non-empty hostInput (e.g. "user@" with no host part).
      //
      // We throw an AppError so the hook normalises it into state:'error' and
      // the inline banner below renders the user message.
      runConnect(async () => {
        throw appErrorFailed(t("ssh.invalid_host"), {
          domain: "ssh",
          code: "invalid-host",
        });
      });
      return;
    }

    const parsedPort = parseSshPort(port);
    if (parsedPort === null) {
      // Port field already shows an inline error via portError — connectDisabled
      // prevents reaching this branch.  Guard kept for defensive completeness.
      return;
    }

    // Capture form values at the moment of submission so closures below are
    // not affected by subsequent re-renders that change the controlled inputs.
    const capturedDest = dest;
    const capturedPort = parsedPort;
    const capturedIdentityFile = identityFile.trim() || undefined;
    const capturedName = name.trim() || undefined;
    const profileId = crypto.randomUUID();

    runConnect(async (_signal) => {
      // --- Stage 1: primary effect — establish SSH browse session ---
      // openBrowseSession is migrated to the IpcResult contract.
      // auth cancellation arrives as ipcErr("cancelled") so we throw an
      // AppError category:"cancelled" and the hook silently returns to idle.
      // _signal is kept in the signature for forward compatibility (AbortSignal
      // passthrough to openSshBrowseSession once it supports cancellation).
      const result = await openSshBrowseSession({
        host: capturedDest.host,
        user: capturedDest.user,
        port: capturedPort,
        identityFile: capturedIdentityFile,
        authMode: "interactive",
      });

      if (!result.ok) {
        if (result.kind === "cancelled") {
          // Auth prompt dismissed by the user — throw category:'cancelled' so the
          // hook routes this to idle without surfacing any error UI.
          throw appErrorCancelled("SSH authentication was cancelled.", { domain: "ssh" });
        }
        // Connection failure → throw so the hook transitions to state:'error'.
        // The inline banner below renders state.error.message.
        throw appErrorFailed(result.message, { domain: "ssh", code: result.kind });
      }

      // `result.value.user` is the user actually connected as — when the form
      // had only a host, the main process resolved it to the local account name,
      // so the saved profile is always complete.
      const connectedUser = result.value.user;
      const sessionId = result.value.sessionId;
      const initialPath = result.value.initialPath;

      // --- Stage 2: secondary effect — persist the connection profile ---
      // Partial-failure policy: a failed save must NOT block the workspace flow.
      // We run the save and inspect the result, but onConnected is called
      // unconditionally as long as stage 1 succeeded.
      const saveResult = await saveConnectionProfileResult({
        id: profileId,
        host: capturedDest.host,
        user: connectedUser,
        port: capturedPort,
        identityFile: capturedIdentityFile,
        authMode: "interactive",
        label: capturedName,
      });

      if (!saveResult.ok) {
        // Save failed — build a retry callback that replays only the save step.
        // The signal from this run() is no longer active after the function
        // returns (the hook clears it in finally), so the retry is a fresh
        // independent call not tied to any AbortController.
        //
        // "Retry save" re-runs only the secondary effect; it never re-connects
        // or re-authenticates. The already-established session is untouched.
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
              // Second attempt also failed — offer another retry via a fresh toast.
              showSaveFailedToast(retrySave);
            }
          });
        };

        // Non-blocking warning toast: the workspace flow proceeds immediately.
        // The toast uses role="alert" (action toast) so it never auto-dismisses
        // and the user can act on the "Retry save" button at their convenience.
        showSaveFailedToast(retrySave);
      }

      // Complete the workspace flow regardless of save outcome.
      // onConnected transitions the parent to the directory picker view.
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
    });
  }

  // ---------------------------------------------------------------------------
  // Derived UI values
  // ---------------------------------------------------------------------------

  const activeDescendant =
    hostListOpen && activeHostIndex >= 0
      ? sshHostOptionId(filteredHosts[activeHostIndex], activeHostIndex)
      : undefined;

  const connecting = connectState.status === "loading";

  // Inline error message for connection failures.
  // Cancelled (state:'idle') and save failures (surfaced as toast) do not reach here.
  const inlineError =
    connectState.status === "error" ? connectState.error.message : null;

  return (
    <form
      id="ssh-new-connection-form"
      className="flex flex-col gap-4"
      onSubmit={(e) => handleConnect(e)}
    >
      {/* Connection error banner — shown for primary (connect) failures only.
          Cancelled auth and save failures are surfaced elsewhere (silent / toast). */}
      {inlineError ? (
        <div
          className="flex items-start gap-2 rounded-(--radius-control) border border-[var(--state-error-border)] bg-[var(--state-error-bg)] px-2 py-2"
          role="alert"
        >
          <AlertCircle
            className="mt-0.5 size-3.5 shrink-0 text-[var(--state-error-fg)]"
            aria-hidden="true"
          />
          <span className="min-w-0 text-app-ui-sm text-[var(--state-error-fg)]">
            {inlineError}
          </span>
        </div>
      ) : null}

      {/* Host combobox — ref is used to detect outside clicks and close the dropdown */}
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

      {/* Name (optional) */}
      <div className="flex flex-col gap-2">
        <label htmlFor={NEW_CONN_NAME_ID} className="text-app-ui-sm text-foreground">
          {t("ssh.label_name")}
          <span className="ml-1 text-app-ui-sm text-muted-foreground">{t("ssh.label_name_optional")}</span>
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

      {/* Advanced collapsible */}
      <div className="rounded-(--radius-control) border border-border px-3 py-2">
        <button
          type="button"
          className="flex w-full items-center justify-between text-left text-app-ui-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-50"
          aria-expanded={advancedOpen}
          aria-controls={NEW_CONN_ADVANCED_ID}
          disabled={connecting}
          onClick={() => setAdvancedOpen((prev) => !prev)}
        >
          <span>{t("ssh.label_advanced")}</span>
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

      {/* Hidden submit trigger for footer primary button */}
      <button type="submit" aria-hidden="true" tabIndex={-1} className="sr-only">
        Connect
      </button>
    </form>
  );
}
