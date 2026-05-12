/**
 * Renderer-only coverage for the Add Workspace dialog.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AddWorkspaceDialogContent,
  filterSshConfigHosts,
  parseSshDestination,
  parseSshPort,
  resolveSshWorkspaceDraft,
} from "../../../../../src/renderer/components/workspace/add-workspace-dialog";

const sshHosts = [
  {
    alias: "devbox",
    host: "dev.example.com",
    user: "ada",
    port: 2222,
    identityFile: "~/.ssh/devbox",
  },
  { alias: "staging", host: "staging.example.com" },
];

describe("AddWorkspaceDialogContent", () => {
  it("renders the local tab with the folder picker submit action", () => {
    const html = renderToStaticMarkup(
      <AddWorkspaceDialogContent {...contentProps({ tab: "local" })} />,
    );

    expect(html).toContain("Add Workspace");
    expect(html).toContain("Local");
    expect(html).toContain("SSH");
    expect(html).toContain("Workspace folder");
    expect(html).toContain("Choose Folder...");
  });

  it("renders the SSH form with combobox accessibility and advanced fields", () => {
    const html = renderToStaticMarkup(
      <AddWorkspaceDialogContent
        {...contentProps({
          tab: "ssh",
          hostInput: "dev",
          hostListOpen: true,
          activeHostIndex: 0,
          remotePath: "/srv/app",
          advancedOpen: true,
        })}
      />,
    );

    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-activedescendant="add-workspace-ssh-host-options-devbox-0"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain("Remote path");
    expect(html).toContain("Name");
    expect(html).toContain("Port");
    expect(html).toContain("Identity file");
  });

  it("renders Interactive as the default SSH authentication method", () => {
    const html = renderToStaticMarkup(
      <AddWorkspaceDialogContent {...contentProps({ tab: "ssh" })} />,
    );

    expect(html).toContain("Authentication");
    expect(html).toContain("Interactive");
    expect(html).toContain("Password / host key prompt");
    expect(html).toContain('checked="" value="interactive"');
  });
});

describe("Add Workspace SSH helpers", () => {
  it("parses direct user@host destinations and validates ports", () => {
    expect(parseSshDestination("ada@dev.example.com")).toEqual({
      user: "ada",
      host: "dev.example.com",
    });
    expect(parseSshDestination("dev.example.com")).toEqual({ host: "dev.example.com" });
    expect(parseSshDestination("ada@")).toBeNull();
    expect(parseSshDestination("dev host")).toBeNull();
    expect(parseSshPort("2222")).toBe(2222);
    expect(parseSshPort("")).toBeUndefined();
    expect(parseSshPort("70000")).toBeNull();
  });

  it("resolves config aliases into testSsh and workspace.create SSH payloads", () => {
    const resolved = resolveSshWorkspaceDraft(
      {
        hostInput: "devbox",
        selectedAlias: "devbox",
        remotePath: "/srv/app",
        port: "2222",
        identityFile: "~/.ssh/devbox",
        authMode: "interactive",
      },
      sshHosts,
    );

    expect(resolved.error).toBeNull();
    if (!resolved.workspace) throw new Error("expected resolved workspace");
    expect(resolved.workspace.testArgs).toEqual({
      host: "devbox",
      user: "ada",
      port: 2222,
      identityFile: "~/.ssh/devbox",
      remotePath: "/srv/app",
      authMode: "interactive",
    });
    expect(resolved.workspace.location).toEqual({
      kind: "ssh",
      host: "devbox",
      user: "ada",
      port: 2222,
      identityFile: "~/.ssh/devbox",
      remotePath: "/srv/app",
      configAlias: "devbox",
      authMode: "interactive",
    });
  });

  it("resolves key-only auth mode into testSsh and workspace.create SSH payloads", () => {
    const resolved = resolveSshWorkspaceDraft(
      {
        hostInput: "ada@dev.example.com",
        selectedAlias: null,
        remotePath: "/srv/app",
        port: "",
        identityFile: "",
        authMode: "key-only",
      },
      sshHosts,
    );

    expect(resolved.error).toBeNull();
    if (!resolved.workspace) throw new Error("expected resolved workspace");
    expect(resolved.workspace.testArgs).toMatchObject({ authMode: "key-only" });
    expect(resolved.workspace.location).toMatchObject({ authMode: "key-only" });
  });

  it("filters config hosts by alias, hostname, and user", () => {
    expect(filterSshConfigHosts(sshHosts, "stag").map((host) => host.alias)).toEqual(["staging"]);
    expect(filterSshConfigHosts(sshHosts, "ada").map((host) => host.alias)).toEqual(["devbox"]);
  });
});

function contentProps(
  overrides: Partial<Parameters<typeof AddWorkspaceDialogContent>[0]> = {},
): Parameters<typeof AddWorkspaceDialogContent>[0] {
  const hostInput = overrides.hostInput ?? "";
  return {
    tab: "ssh",
    hosts: sshHosts,
    filteredHosts: filterSshConfigHosts(sshHosts, hostInput),
    hostsLoading: false,
    hostsError: null,
    hostInput,
    selectedHost: null,
    hostListOpen: false,
    activeHostIndex: -1,
    remotePath: "",
    name: "",
    port: "",
    identityFile: "",
    authMode: "interactive",
    advancedOpen: false,
    phase: "idle",
    errorMessage: null,
    statusMessage: null,
    sshValidationError: null,
    portError: null,
    onTabChange: () => {},
    onHostInputChange: () => {},
    onHostFocus: () => {},
    onHostKeyDown: () => {},
    onHostListOpenChange: () => {},
    onSelectHost: () => {},
    onRemotePathChange: () => {},
    onNameChange: () => {},
    onPortChange: () => {},
    onIdentityFileChange: () => {},
    onAuthModeChange: () => {},
    onAdvancedOpenChange: () => {},
    onCancel: () => {},
    onSubmit: () => {},
    ...overrides,
  };
}
