import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteAccountState } from "../../../../../src/shared/remote/account";
import { SERVER } from "../../../../../src/shared/remote/server";

const { AccountGroup, DeleteAccountGroup, DeviceRow } = await import(
  "../../../../../src/renderer/components/settings/panels/remote-panel"
);

const server = "http://localhost:8787";
const render = (state: RemoteAccountState, signIns?: ("google" | "github" | "dev")[]) =>
  renderToStaticMarkup(<AccountGroup state={state} signIns={signIns} />);

describe("the remote panel's account", () => {
  test("offers the sign-in, saying why the last one failed", () => {
    const html = render({ status: "signed-out", server, failure: "unverified_email" });
    expect(html).toContain("Sign in with Google");
    expect(html).toContain("email isn&#x27;t verified.");
    expect(html).toContain(`Server: ${server}`);
  });

  test("offers the sign-ins the server has", () => {
    const html = render({ status: "signed-out", server }, ["dev"]);
    expect(html).toContain("Sign in (dev server)");
    expect(html).not.toContain("Sign in with Google");
    const both = render({ status: "signed-out", server }, ["google", "github"]);
    expect(both).toContain("Sign in with Google");
    expect(both).toContain("Sign in with GitHub");
  });

  test("marks each sign-in with its provider, and the dev one as local only", () => {
    const html = render({ status: "signed-out", server }, ["google", "github", "dev"]);
    expect(html).toContain('data-provider="google"');
    // Google's four-color G, as its branding asks, and Roboto.
    for (const color of ["#EA4335", "#4285F4", "#FBBC05", "#34A853"]) {
      expect(html).toContain(color);
    }
    expect(html).toContain("Roboto");
    expect(html).toContain('data-provider="github"');
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain('data-provider="dev"');
    expect(html).toContain("Local server only");
  });

  test("says when the server could not be reached, and offers to ask again", () => {
    const html = renderToStaticMarkup(
      <AccountGroup state={{ status: "signed-out", server }} unreachable onRetry={() => {}} />,
    );
    expect(html).toContain("reach the server.");
    expect(html).toContain("Try again");
    // The sign-in stays: the server may answer it.
    expect(html).toContain("Sign in with Google");
    const reached = render({ status: "signed-out", server });
    expect(reached).not.toContain("Try again");
  });

  test("says nothing of a sign-in the user cancelled", () => {
    const html = render({ status: "signed-out", server, failure: "cancelled" });
    expect(html).toContain("Sign in with Google");
    expect(html).not.toContain('role="alert"');
  });

  test("while the browser is out, offers to stop waiting", () => {
    const html = render({ status: "signing-in", server });
    expect(html).toContain("Continue in your browser");
    expect(html).toContain("Cancel");
    expect(html).not.toContain("Sign in with Google");
  });

  test("once signed in, says as whom, and offers the sign-out", () => {
    const html = render({
      status: "signed-in",
      server,
      user: { id: "u1", email: "me@example.com", name: "Me" },
      device: { id: "d1", name: "Mac", platform: "darwin" },
    });
    expect(html).toContain("Me");
    expect(html).toContain("me@example.com");
    expect(html).toContain("Sign out");
    // Signed in, the page does not explain signing in.
    expect(html).not.toContain("Sign in to see");
  });

  test("names the server only when it is not the released app's own", () => {
    const html = render({ status: "signed-out", server: SERVER });
    expect(html).not.toContain("Server:");
    expect(render({ status: "signed-out", server })).toContain(`Server: ${server}`);
  });

  test("names each device's system, and tags this one", () => {
    const html = renderToStaticMarkup(
      <DeviceRow
        device={{ id: "d1", name: "Work PC", platform: "win32" }}
        current
        online
        onAlias={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Online"');
    expect(html).toContain('aria-label="Set an alias for Work PC"');
    expect(html).toContain("Work PC");
    expect(html).toContain("Windows");
    expect(html).toContain("This device");
    expect(html).toContain('aria-label="Remove Work PC"');
  });

  test("names a device by its alias, with the name it signed in with beside it", () => {
    const html = renderToStaticMarkup(
      <DeviceRow
        device={{ id: "d1", name: "DESKTOP-7Q2", alias: "Work PC", platform: "win32" }}
        current={false}
        onAlias={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(html).toContain(">Work PC</span>");
    expect(html).toContain("DESKTOP-7Q2 · Windows");
    expect(html).toContain('aria-label="Remove Work PC"');
  });
});

const { AccountKeyGroup } = await import(
  "../../../../../src/renderer/components/settings/panels/remote-key-group"
);

describe("the remote panel's account password", () => {
  const renderKey = (state: Parameters<typeof AccountKeyGroup>[0]["state"]) =>
    renderToStaticMarkup(<AccountKeyGroup state={state} />);

  test("the first device sets it, typed twice, at 12 characters or more", () => {
    const html = renderKey({ status: "missing" });
    expect(html).toContain("at least 12 characters");
    expect(html.match(/type="password"/g)).toHaveLength(2);
    expect(html).toContain("Set password");
  });

  test("another device types it, or resets it when it is forgotten", () => {
    const html = renderKey({ status: "locked", kid: 1 });
    expect(html.match(/type="password"/g)).toHaveLength(1);
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain("Unlock");
    expect(html).toContain("Forgot the password?");
  });

  test("a device holding the key offers the change and the reset", () => {
    const html = renderKey({ status: "unlocked", kid: 2 });
    expect(html).toContain(">Unlocked<");
    expect(html).toContain("This device holds the account key");
    expect(html).not.toContain("Key version");
    expect(html).toContain("Change password");
    expect(html).toContain("Reset");
    expect(html).not.toContain('type="password"');
  });

  test("a server that could not be asked offers to try again", () => {
    const html = renderKey({ status: "unavailable", retryAt: 1 });
    expect(html).toContain("check with the server.");
    expect(html).toContain("Try again in a minute.");
    expect(html).toContain("Try again");
  });
});

describe("the remote panel's account deletion", () => {
  test("offers it, saying it cannot be undone", () => {
    const html = renderToStaticMarkup(<DeleteAccountGroup keyState={null} />);
    expect(html).toContain("Delete your NexusCode account");
    expect(html).toContain("for good");
    expect(html).toContain('data-variant="destructive"');
  });
});

const { VoiceGroup, VoiceTermChips } = await import(
  "../../../../../src/renderer/components/settings/panels/remote-voice-group"
);

describe("the remote panel's voice input", () => {
  test("offers the account's recognition terms and the names switch, off by default", () => {
    const html = renderToStaticMarkup(<VoiceGroup />);
    expect(html).toContain("Recognition terms");
    expect(html).toContain('placeholder="Add a term"');
    expect(html).toContain('aria-label="Add"');
    expect(html).toContain("Used for dictation on all your devices.");
    expect(html).toContain("Send computer and workspace names");
    expect(html).toContain("Sent to the speech recognition service along with your dictation.");
    expect(html).toContain('aria-checked="false"');
    // The terms are still being asked for: the field waits.
    expect(html).toContain("Loading…");
  });

  test("shows each term as a chip with its remove button, or says there are none", () => {
    const html = renderToStaticMarkup(
      <VoiceTermChips terms={["Soniox", "Tauri"]} onRemove={() => {}} />,
    );
    expect(html).toContain("Soniox");
    expect(html).toContain('aria-label="Remove Soniox"');
    expect(html).toContain('aria-label="Remove Tauri"');
    expect(renderToStaticMarkup(<VoiceTermChips terms={[]} onRemove={() => {}} />)).toContain(
      "No terms",
    );
    expect(
      renderToStaticMarkup(<VoiceTermChips terms="unavailable" onRemove={() => {}} />),
    ).toContain("load the terms.");
  });
});
