import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  LoaderCircle,
  Server,
} from "lucide-react";
import { Dialog as RadixDialog, Tabs as RadixTabs } from "radix-ui";
import type { FormEvent, KeyboardEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceLocation, WorkspaceMeta } from "../../../shared/types/workspace";
import { ipcCall } from "../../ipc/client";
import type { CallArgs, CallReturn } from "../../ipc/types";
import { Button } from "../ui/button";

type WorkspaceTab = "local" | "ssh";
type DialogPhase = "idle" | "local-creating" | "connecting" | "creating";
type SshConfigHost = CallReturn<"ssh", "listConfigHosts">[number];
type WorkspaceTestSshArgs = CallArgs<"workspace", "testSsh">;
type SshWorkspaceLocation = Extract<WorkspaceLocation, { kind: "ssh" }>;
type SshAuthMode = NonNullable<SshWorkspaceLocation["authMode"]>;

interface AddWorkspaceDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onWorkspaceCreated: (meta: WorkspaceMeta) => void | Promise<void>;
}

interface SshWorkspaceDraft {
  readonly hostInput: string;
  readonly selectedAlias: string | null;
  readonly remotePath: string;
  readonly port: string;
  readonly identityFile: string;
  readonly authMode: SshAuthMode;
}

interface ResolvedSshWorkspace {
  readonly testArgs: WorkspaceTestSshArgs;
  readonly location: SshWorkspaceLocation;
}

interface AddWorkspaceDialogContentProps {
  readonly tab: WorkspaceTab;
  readonly hosts: readonly SshConfigHost[];
  readonly filteredHosts: readonly SshConfigHost[];
  readonly hostsLoading: boolean;
  readonly hostsError: string | null;
  readonly hostInput: string;
  readonly selectedHost: SshConfigHost | null;
  readonly hostListOpen: boolean;
  readonly activeHostIndex: number;
  readonly remotePath: string;
  readonly name: string;
  readonly port: string;
  readonly identityFile: string;
  readonly authMode: SshAuthMode;
  readonly advancedOpen: boolean;
  readonly phase: DialogPhase;
  readonly errorMessage: string | null;
  readonly statusMessage: string | null;
  readonly sshValidationError: string | null;
  readonly portError: string | null;
  readonly onTabChange: (tab: WorkspaceTab) => void;
  readonly onHostInputChange: (value: string) => void;
  readonly onHostFocus: () => void;
  readonly onHostKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly onHostListOpenChange: (open: boolean) => void;
  readonly onSelectHost: (host: SshConfigHost) => void;
  readonly onRemotePathChange: (value: string) => void;
  readonly onNameChange: (value: string) => void;
  readonly onPortChange: (value: string) => void;
  readonly onIdentityFileChange: (value: string) => void;
  readonly onAuthModeChange: (value: SshAuthMode) => void;
  readonly onAdvancedOpenChange: () => void;
  readonly onCancel: () => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

const HOST_OPTIONS_ID = "add-workspace-ssh-host-options";
const HOST_INPUT_ID = "add-workspace-ssh-host";
const REMOTE_PATH_ID = "add-workspace-ssh-remote-path";
const NAME_ID = "add-workspace-ssh-name";
const PORT_ID = "add-workspace-ssh-port";
const IDENTITY_FILE_ID = "add-workspace-ssh-identity-file";
const AUTH_MODE_GROUP_ID = "add-workspace-ssh-auth-mode";
const SSH_ERROR_ID = "add-workspace-ssh-error";
const PORT_ERROR_ID = "add-workspace-ssh-port-error";
const SSH_AUTH_OPTIONS: readonly {
  value: SshAuthMode;
  label: string;
  description: string;
}[] = [
  {
    value: "interactive",
    label: "Interactive",
    description: "Password / host key prompt",
  },
  {
    value: "key-only",
    label: "Key only",
    description: "BatchMode; fail instead of prompting",
  },
];

export function AddWorkspaceDialog({
  open,
  onClose,
  onWorkspaceCreated,
}: AddWorkspaceDialogProps): React.JSX.Element {
  const [tab, setTab] = useState<WorkspaceTab>("local");
  const [hosts, setHosts] = useState<SshConfigHost[]>([]);
  const [hostsLoading, setHostsLoading] = useState(false);
  const [hostsError, setHostsError] = useState<string | null>(null);
  const [hostInput, setHostInput] = useState("");
  const [selectedAlias, setSelectedAlias] = useState<string | null>(null);
  const [hostListOpen, setHostListOpen] = useState(false);
  const [activeHostIndex, setActiveHostIndex] = useState(-1);
  const [remotePath, setRemotePath] = useState("");
  const [name, setName] = useState("");
  const [port, setPort] = useState("");
  const [identityFile, setIdentityFile] = useState("");
  const [authMode, setAuthMode] = useState<SshAuthMode>("interactive");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [phase, setPhase] = useState<DialogPhase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const testAbortRef = useRef<AbortController | null>(null);

  const filteredHosts = useMemo(() => filterSshConfigHosts(hosts, hostInput), [hosts, hostInput]);
  const selectedHost = findSshConfigHost(hosts, hostInput, selectedAlias);
  const sshDraft = useMemo<SshWorkspaceDraft>(
    () => ({ hostInput, selectedAlias, remotePath, port, identityFile, authMode }),
    [hostInput, selectedAlias, remotePath, port, identityFile, authMode],
  );
  const resolvedSsh = resolveSshWorkspaceDraft(sshDraft, hosts);
  const portError =
    port.trim().length > 0 && parseSshPort(port) === null ? "Port must be 1-65535." : null;
  const sshValidationError =
    tab === "ssh" && resolvedSsh.error && (hostInput.trim() || remotePath.trim() || port.trim())
      ? resolvedSsh.error
      : null;

  useEffect(() => {
    if (!open) {
      testAbortRef.current?.abort();
      testAbortRef.current = null;
      return;
    }

    setTab("local");
    setHostInput("");
    setSelectedAlias(null);
    setHostListOpen(false);
    setActiveHostIndex(-1);
    setRemotePath("");
    setName("");
    setPort("");
    setIdentityFile("");
    setAuthMode("interactive");
    setAdvancedOpen(false);
    setPhase("idle");
    setErrorMessage(null);
    setStatusMessage(null);

    let cancelled = false;
    setHostsLoading(true);
    setHostsError(null);
    ipcCall("ssh", "listConfigHosts", undefined)
      .then((list) => {
        if (cancelled) return;
        setHosts(list);
      })
      .catch(() => {
        if (cancelled) return;
        setHosts([]);
        setHostsError("SSH config hosts unavailable.");
      })
      .finally(() => {
        if (!cancelled) setHostsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!hostListOpen) return;
    setActiveHostIndex((current) => clampHostIndex(current, filteredHosts.length));
  }, [hostListOpen, filteredHosts.length]);

  function closeAndAbort(): void {
    testAbortRef.current?.abort();
    testAbortRef.current = null;
    setHostListOpen(false);
    onClose();
  }

  function changeHostInput(value: string): void {
    setHostInput(value);
    setSelectedAlias(null);
    setErrorMessage(null);
    setStatusMessage(null);
    setHostListOpen(true);
    setActiveHostIndex(filteredHosts.length > 0 ? 0 : -1);
  }

  function selectHost(host: SshConfigHost): void {
    setHostInput(host.alias);
    setSelectedAlias(host.alias);
    setPort(host.port ? String(host.port) : "");
    setIdentityFile(host.identityFile ?? "");
    setHostListOpen(false);
    setActiveHostIndex(-1);
    setErrorMessage(null);
    setStatusMessage(null);
  }

  function handleHostKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filteredHosts.length === 0) return;
      setHostListOpen(true);
      setActiveHostIndex((current) => (current + 1) % filteredHosts.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filteredHosts.length === 0) return;
      setHostListOpen(true);
      setActiveHostIndex((current) => (current <= 0 ? filteredHosts.length - 1 : current - 1));
      return;
    }

    if (event.key === "Enter" && hostListOpen && activeHostIndex >= 0) {
      const host = filteredHosts[activeHostIndex];
      if (!host) return;
      event.preventDefault();
      selectHost(host);
      return;
    }

    if (event.key === "Escape" && hostListOpen) {
      event.preventDefault();
      setHostListOpen(false);
      setActiveHostIndex(-1);
    }
  }

  async function createLocalWorkspace(): Promise<void> {
    setPhase("local-creating");
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const { canceled, filePaths } = await ipcCall("dialog", "showOpenDirectory", {
        title: "Select workspace folder",
      });
      if (canceled || !filePaths[0]) {
        setPhase("idle");
        return;
      }

      const meta = await ipcCall("workspace", "create", {
        location: { kind: "local", rootPath: filePaths[0] },
      });
      await onWorkspaceCreated(meta);
      onClose();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not add workspace.");
    } finally {
      setPhase("idle");
    }
  }

  async function createSshWorkspace(): Promise<void> {
    const resolved = resolveSshWorkspaceDraft(sshDraft, hosts);
    if (!resolved.workspace) {
      setErrorMessage(resolved.error);
      return;
    }
    const workspace = resolved.workspace;

    const controller = new AbortController();
    testAbortRef.current = controller;
    setPhase("connecting");
    setErrorMessage(null);
    setStatusMessage("Connecting to SSH workspace...");

    try {
      const result = await ipcCall("workspace", "testSsh", workspace.testArgs, {
        signal: controller.signal,
      });
      testAbortRef.current = null;

      if (!result.ok) {
        setPhase("idle");
        setStatusMessage(null);
        setErrorMessage(`${result.message} (${result.code})`);
        return;
      }

      setPhase("creating");
      setStatusMessage("Connection verified. Adding workspace...");
      const trimmedName = name.trim();
      const meta = await ipcCall("workspace", "create", {
        location: workspace.location,
        name: trimmedName || undefined,
      });
      await onWorkspaceCreated(meta);
      onClose();
    } catch (error) {
      if (!isAbortError(error)) {
        setErrorMessage(error instanceof Error ? error.message : "Could not add SSH workspace.");
      }
    } finally {
      if (testAbortRef.current === controller) {
        testAbortRef.current = null;
      }
      setPhase("idle");
      setStatusMessage(null);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (phase !== "idle") return;
    if (tab === "local") {
      void createLocalWorkspace();
    } else {
      void createSshWorkspace();
    }
  }

  return (
    <RadixDialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeAndAbort();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <RadixDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[560px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 rounded-[--radius-container] border border-border bg-background p-5 text-foreground shadow-none outline-none">
          <RadixDialog.Title className="sr-only">Add Workspace</RadixDialog.Title>
          <RadixDialog.Description className="sr-only">
            Add a local or SSH workspace.
          </RadixDialog.Description>
          <AddWorkspaceDialogContent
            tab={tab}
            hosts={hosts}
            filteredHosts={filteredHosts}
            hostsLoading={hostsLoading}
            hostsError={hostsError}
            hostInput={hostInput}
            selectedHost={selectedHost}
            hostListOpen={hostListOpen}
            activeHostIndex={activeHostIndex}
            remotePath={remotePath}
            name={name}
            port={port}
            identityFile={identityFile}
            authMode={authMode}
            advancedOpen={advancedOpen}
            phase={phase}
            errorMessage={errorMessage}
            statusMessage={statusMessage}
            sshValidationError={sshValidationError}
            portError={portError}
            onTabChange={setTab}
            onHostInputChange={changeHostInput}
            onHostFocus={() => {
              if (filteredHosts.length > 0) setHostListOpen(true);
            }}
            onHostKeyDown={handleHostKeyDown}
            onHostListOpenChange={setHostListOpen}
            onSelectHost={selectHost}
            onRemotePathChange={(value) => {
              setRemotePath(value);
              setErrorMessage(null);
              setStatusMessage(null);
            }}
            onNameChange={setName}
            onPortChange={(value) => {
              setPort(value);
              setErrorMessage(null);
              setStatusMessage(null);
            }}
            onIdentityFileChange={setIdentityFile}
            onAuthModeChange={setAuthMode}
            onAdvancedOpenChange={() => setAdvancedOpen((current) => !current)}
            onCancel={closeAndAbort}
            onSubmit={submit}
          />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export function AddWorkspaceDialogContent({
  tab,
  hosts,
  filteredHosts,
  hostsLoading,
  hostsError,
  hostInput,
  selectedHost,
  hostListOpen,
  activeHostIndex,
  remotePath,
  name,
  port,
  identityFile,
  authMode,
  advancedOpen,
  phase,
  errorMessage,
  statusMessage,
  sshValidationError,
  portError,
  onTabChange,
  onHostInputChange,
  onHostFocus,
  onHostKeyDown,
  onHostListOpenChange,
  onSelectHost,
  onRemotePathChange,
  onNameChange,
  onPortChange,
  onIdentityFileChange,
  onAuthModeChange,
  onAdvancedOpenChange,
  onCancel,
  onSubmit,
}: AddWorkspaceDialogContentProps): React.JSX.Element {
  const busy = phase !== "idle";
  const connecting = phase === "connecting";
  const localBusy = phase === "local-creating";
  const creating = phase === "creating";
  const sshSubmitDisabled =
    busy ||
    hostInput.trim().length === 0 ||
    remotePath.trim().length === 0 ||
    parseSshPort(port) === null;
  const submitDisabled = tab === "ssh" ? sshSubmitDisabled : busy;
  const primaryLabel =
    tab === "local"
      ? localBusy
        ? "Adding..."
        : "Choose Folder..."
      : connecting
        ? "Connecting"
        : creating
          ? "Adding..."
          : errorMessage
            ? "Retry"
            : "Add";
  const activeDescendant =
    hostListOpen && activeHostIndex >= 0
      ? hostOptionId(filteredHosts[activeHostIndex], activeHostIndex)
      : undefined;
  const selectedSummary = selectedHost ? formatSshHostSummary(selectedHost) : null;

  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      <div>
        <div className="text-app-body-emphasis text-foreground">Add Workspace</div>
        <div className="mt-2 text-app-ui-sm text-muted-foreground">
          Create a workspace from a local folder or SSH target.
        </div>
      </div>

      <RadixTabs.Root
        value={tab}
        onValueChange={(value) => {
          if (isWorkspaceTab(value) && !busy) onTabChange(value);
        }}
      >
        <RadixTabs.List
          aria-label="Workspace location"
          className="inline-flex rounded border border-border bg-muted p-0.5"
        >
          <RadixTabs.Trigger
            type="button"
            value="local"
            disabled={busy}
            className="inline-flex h-8 items-center gap-2 rounded-[--radius-control] px-3 text-app-ui-sm text-muted-foreground outline-none data-[state=active]:bg-background data-[state=active]:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          >
            <FolderOpen className="size-4" aria-hidden="true" />
            Local
          </RadixTabs.Trigger>
          <RadixTabs.Trigger
            type="button"
            value="ssh"
            disabled={busy}
            className="inline-flex h-8 items-center gap-2 rounded-[--radius-control] px-3 text-app-ui-sm text-muted-foreground outline-none data-[state=active]:bg-background data-[state=active]:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          >
            <Server className="size-4" aria-hidden="true" />
            SSH
          </RadixTabs.Trigger>
        </RadixTabs.List>

        <RadixTabs.Content value="local" className="mt-4 outline-none">
          <div className="rounded-[--radius-control] border border-border bg-muted px-3 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <FolderOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0">
                <div className="text-app-ui-sm text-foreground">Workspace folder</div>
                <div className="truncate text-app-ui-sm text-muted-foreground">
                  Selected with the native folder picker.
                </div>
              </div>
            </div>
          </div>
        </RadixTabs.Content>

        <RadixTabs.Content value="ssh" className="mt-4 outline-none">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <label htmlFor={HOST_INPUT_ID} className="text-app-ui-sm text-foreground">
                Host
              </label>
              <div className="relative">
                <div className="flex items-center gap-2">
                  <input
                    id={HOST_INPUT_ID}
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={hostListOpen}
                    aria-controls={HOST_OPTIONS_ID}
                    aria-activedescendant={activeDescendant}
                    aria-invalid={sshValidationError ? true : undefined}
                    aria-describedby={sshValidationError ? SSH_ERROR_ID : undefined}
                    value={hostInput}
                    onChange={(event) => onHostInputChange(event.currentTarget.value)}
                    onFocus={onHostFocus}
                    onKeyDown={onHostKeyDown}
                    disabled={busy}
                    placeholder="user@host or SSH config alias"
                    className="min-w-0 flex-1 rounded-[--radius-control] border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 aria-invalid:border-destructive"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label={hostListOpen ? "Close SSH config hosts" : "Open SSH config hosts"}
                    aria-expanded={hostListOpen}
                    disabled={busy || hosts.length === 0}
                    onClick={() => onHostListOpenChange(!hostListOpen)}
                  >
                    <ChevronDown className="size-4" aria-hidden="true" />
                  </Button>
                </div>
                {hostListOpen ? (
                  <div
                    id={HOST_OPTIONS_ID}
                    role="listbox"
                    className="absolute left-0 right-10 top-[calc(100%+4px)] z-10 max-h-44 overflow-y-auto rounded border border-border bg-popover p-1 text-popover-foreground shadow-none"
                  >
                    {filteredHosts.length > 0 ? (
                      filteredHosts.map((host, index) => (
                        <button
                          key={host.alias}
                          id={hostOptionId(host, index)}
                          type="button"
                          role="option"
                          aria-selected={index === activeHostIndex}
                          className="flex w-full min-w-0 flex-col rounded-[--radius-control] px-2 py-2 text-left text-app-ui-sm hover:bg-[var(--state-hover-bg)] focus-visible:bg-[var(--state-hover-bg)] focus-visible:outline-none aria-selected:bg-[var(--state-active-bg)]"
                          onClick={() => onSelectHost(host)}
                        >
                          <span className="truncate text-foreground">{host.alias}</span>
                          <span className="truncate text-app-ui-sm text-muted-foreground">
                            {formatSshHostSummary(host)}
                          </span>
                        </button>
                      ))
                    ) : (
                      <div className="px-2 py-2 text-app-ui-sm text-muted-foreground">
                        {hostsLoading
                          ? "Loading SSH config hosts..."
                          : "No matching SSH config hosts."}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
              {selectedSummary ? (
                <p className="text-app-ui-sm text-muted-foreground">
                  <CheckCircle2 className="mr-1 inline size-3" aria-hidden="true" />
                  {selectedSummary}
                </p>
              ) : hostsError ? (
                <p className="text-app-ui-sm text-muted-foreground">{hostsError}</p>
              ) : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.75fr)]">
              <div className="flex min-w-0 flex-col gap-2">
                <label htmlFor={REMOTE_PATH_ID} className="text-app-ui-sm text-foreground">
                  Remote path
                </label>
                <input
                  id={REMOTE_PATH_ID}
                  value={remotePath}
                  onChange={(event) => onRemotePathChange(event.currentTarget.value)}
                  disabled={busy}
                  aria-invalid={sshValidationError ? true : undefined}
                  aria-describedby={sshValidationError ? SSH_ERROR_ID : undefined}
                  placeholder="/srv/project"
                  className="w-full rounded-[--radius-control] border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 aria-invalid:border-destructive"
                />
              </div>
              <div className="flex min-w-0 flex-col gap-2">
                <label htmlFor={NAME_ID} className="text-app-ui-sm text-foreground">
                  Name
                </label>
                <input
                  id={NAME_ID}
                  value={name}
                  onChange={(event) => onNameChange(event.currentTarget.value)}
                  disabled={busy}
                  placeholder="Optional"
                  className="w-full rounded-[--radius-control] border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                />
              </div>
            </div>

            <fieldset
              id={AUTH_MODE_GROUP_ID}
              className="rounded-[--radius-control] border border-border bg-background/60 px-2 py-2"
              disabled={busy}
            >
              <legend className="px-1 text-app-ui-sm text-foreground">Authentication</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {SSH_AUTH_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    className="flex cursor-pointer items-start gap-2 rounded-[--radius-control] border border-border bg-muted px-2 py-2 text-left outline-none focus-within:ring-1 focus-within:ring-ring"
                  >
                    <input
                      type="radio"
                      name="ssh-auth-mode"
                      value={option.value}
                      checked={authMode === option.value}
                      disabled={busy}
                      onChange={() => onAuthModeChange(option.value)}
                      className="mt-0.5 size-3.5 accent-foreground"
                    />
                    <span className="min-w-0">
                      <span className="block text-app-ui-sm text-foreground">{option.label}</span>
                      <span className="block text-app-ui-sm text-muted-foreground">
                        {option.description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="rounded-[--radius-control] border border-border bg-background/60 px-2 py-2">
              <button
                type="button"
                className="flex w-full items-center justify-between text-left text-app-ui-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                aria-expanded={advancedOpen}
                disabled={busy}
                onClick={onAdvancedOpenChange}
              >
                <span>Advanced</span>
                {advancedOpen ? (
                  <ChevronDown className="size-4" aria-hidden="true" />
                ) : (
                  <ChevronRight className="size-4" aria-hidden="true" />
                )}
              </button>
              {advancedOpen ? (
                <div className="mt-3 grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
                  <div className="flex min-w-0 flex-col gap-2">
                    <label htmlFor={PORT_ID} className="text-app-ui-sm text-foreground">
                      Port
                    </label>
                    <input
                      id={PORT_ID}
                      type="text"
                      inputMode="numeric"
                      value={port}
                      onChange={(event) => onPortChange(event.currentTarget.value)}
                      disabled={busy}
                      aria-invalid={portError ? true : undefined}
                      aria-describedby={portError ? PORT_ERROR_ID : undefined}
                      placeholder="22"
                      className="w-full rounded-[--radius-control] border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 aria-invalid:border-destructive"
                    />
                    {portError ? (
                      <p id={PORT_ERROR_ID} className="text-app-ui-sm text-destructive">
                        {portError}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex min-w-0 flex-col gap-2">
                    <label htmlFor={IDENTITY_FILE_ID} className="text-app-ui-sm text-foreground">
                      Identity file
                    </label>
                    <input
                      id={IDENTITY_FILE_ID}
                      value={identityFile}
                      onChange={(event) => onIdentityFileChange(event.currentTarget.value)}
                      disabled={busy}
                      placeholder="~/.ssh/id_ed25519"
                      className="w-full rounded-[--radius-control] border border-border bg-background px-2 py-1 text-app-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                    />
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </RadixTabs.Content>
      </RadixTabs.Root>

      {sshValidationError ? (
        <p id={SSH_ERROR_ID} className="text-app-ui-sm text-destructive" role="alert">
          {sshValidationError}
        </p>
      ) : null}

      {statusMessage ? (
        <p className="text-app-ui-sm text-muted-foreground" role="status" aria-live="polite">
          {statusMessage}
        </p>
      ) : null}

      {errorMessage ? (
        <div
          className="flex items-start gap-2 rounded-[--radius-control] border border-destructive/60 bg-destructive/10 px-2 py-2 text-app-ui-sm text-destructive"
          role="alert"
        >
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{errorMessage}</span>
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={creating} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={submitDisabled} className="min-w-[7.5rem]">
          {busy ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          ) : tab === "local" ? (
            <FolderOpen className="size-4" aria-hidden="true" />
          ) : (
            <Server className="size-4" aria-hidden="true" />
          )}
          {primaryLabel}
        </Button>
      </div>
    </form>
  );
}

export function parseSshDestination(input: string): { host: string; user?: string } | null {
  const value = input.trim();
  if (!value) return null;
  const atIndex = value.lastIndexOf("@");
  if (atIndex > 0 && atIndex < value.length - 1) {
    const user = value.slice(0, atIndex).trim();
    const host = value.slice(atIndex + 1).trim();
    if (!host || hostHasWhitespace(host) || user.length === 0) return null;
    return { host, user };
  }
  if (value.includes("@")) return null;
  if (hostHasWhitespace(value)) return null;
  return { host: value };
}

export function parseSshPort(value: string): number | undefined | null {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!/^\d+$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65_535 ? port : null;
}

export function filterSshConfigHosts(
  hosts: readonly SshConfigHost[],
  query: string,
): SshConfigHost[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return hosts.slice(0, 8);
  return hosts
    .filter((host) =>
      [host.alias, host.host, host.user]
        .filter((value): value is string => typeof value === "string")
        .some((value) => value.toLowerCase().includes(normalized)),
    )
    .slice(0, 8);
}

export function findSshConfigHost(
  hosts: readonly SshConfigHost[],
  hostInput: string,
  selectedAlias: string | null,
): SshConfigHost | null {
  const alias = selectedAlias ?? hostInput.trim();
  if (!alias || alias.includes("@")) return null;
  return hosts.find((host) => host.alias === alias) ?? null;
}

export function resolveSshWorkspaceDraft(
  draft: SshWorkspaceDraft,
  hosts: readonly SshConfigHost[],
): { workspace: ResolvedSshWorkspace; error: null } | { workspace: null; error: string } {
  const configHost = findSshConfigHost(hosts, draft.hostInput, draft.selectedAlias);
  const parsedDestination = configHost
    ? { host: configHost.alias, user: configHost.user }
    : parseSshDestination(draft.hostInput);
  if (!parsedDestination) {
    return { workspace: null, error: "Enter a host or user@host." };
  }

  const remotePath = draft.remotePath.trim();
  if (!remotePath) {
    return { workspace: null, error: "Remote path is required." };
  }

  const port = parseSshPort(draft.port);
  if (port === null) {
    return { workspace: null, error: "Port must be 1-65535." };
  }

  const identityFile = draft.identityFile.trim() || undefined;
  const testArgs: WorkspaceTestSshArgs = {
    host: parsedDestination.host,
    remotePath,
    authMode: draft.authMode,
  };
  const location: SshWorkspaceLocation = {
    kind: "ssh",
    host: parsedDestination.host,
    remotePath,
    authMode: draft.authMode,
  };

  if (parsedDestination.user) {
    testArgs.user = parsedDestination.user;
    location.user = parsedDestination.user;
  }
  if (port !== undefined) {
    testArgs.port = port;
    location.port = port;
  }
  if (identityFile) {
    testArgs.identityFile = identityFile;
    location.identityFile = identityFile;
  }
  if (configHost) {
    location.configAlias = configHost.alias;
  }

  return { workspace: { testArgs, location }, error: null };
}

function isWorkspaceTab(value: string): value is WorkspaceTab {
  return value === "local" || value === "ssh";
}

function hostHasWhitespace(host: string): boolean {
  return /\s/.test(host);
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

function clampHostIndex(index: number, length: number): number {
  if (length === 0) return -1;
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}

function hostOptionId(host: SshConfigHost | undefined, index: number): string {
  return `${HOST_OPTIONS_ID}-${host?.alias.replace(/[^A-Za-z0-9_-]/g, "_") ?? "item"}-${index}`;
}

function formatSshHostSummary(host: SshConfigHost): string {
  const destination = host.host ?? host.alias;
  const userPrefix = host.user ? `${host.user}@` : "";
  const portSuffix = host.port ? `:${host.port}` : "";
  const identitySuffix = host.identityFile ? ` - ${host.identityFile}` : "";
  return `${userPrefix}${destination}${portSuffix}${identitySuffix}`;
}
