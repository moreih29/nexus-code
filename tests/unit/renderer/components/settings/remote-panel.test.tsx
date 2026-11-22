import { describe, expect, spyOn, test } from "bun:test";
import type { MouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as button from "../../../../../src/renderer/components/ui/button";
import * as ipc from "../../../../../src/renderer/ipc/client";
import * as theme from "../../../../../src/renderer/state/stores/theme";
import { ipcOk } from "../../../../../src/shared/ipc/result";
import type { RemoteAccountState } from "../../../../../src/shared/remote/account";
import { SERVER } from "../../../../../src/shared/remote/server";

const { AccountGroup, DeleteAccountGroup, DeviceRow } = await import(
  "../../../../../src/renderer/components/settings/panels/remote-panel"
);

const server = "http://localhost:8787";
const render = (state: RemoteAccountState, signIns?: readonly string[]) =>
  renderToStaticMarkup(<AccountGroup state={state} signIns={signIns} />);

describe("the remote panel's account", () => {
  test("offers the sign-in, saying why the last one failed", () => {
    const html = render({ status: "signed-out", server, failure: "unverified_email" });
    expect(html).toContain("Sign in with Google");
    expect(html).toContain("email isn&#x27;t verified.");
    expect(html).toContain(`Server: ${server}`);
  });

  test("offers to check approval again alongside the provider buttons", () => {
    const state = { status: "signed-out", server, failure: "pending_approval" } as const;
    const call = spyOn(ipc, "ipcCallResult").mockResolvedValue(ipcOk(state));
    const renderButton = spyOn(button, "Button");
    try {
      const html = render(state, ["google", "github"]);
      expect(html).toContain("Awaiting approval · Sign in the same way after approval");
      expect(html).toContain("Sign in with Google");
      expect(html).toContain("Sign in with GitHub");
      const action = renderButton.mock.calls.find(([props]) => props.children === "Check Again");
      action?.[0].onClick?.({} as MouseEvent<HTMLButtonElement>);
      expect(call).toHaveBeenCalledWith("remote", "signIn", undefined);
    } finally {
      renderButton.mockRestore();
      call.mockRestore();
    }
  });

  test("links to the Store-listed support page for a suspended account", () => {
    const html = render({ status: "signed-out", server, failure: "suspended" });
    expect(html).toContain("Account suspended");
    expect(html).toContain('href="https://github.com/moreih29/nexus-code/issues"');
    expect(html).toContain("Open Support Page");
    expect(html).not.toContain("Check Again");
  });

  test("offers the sign-ins the server has", () => {
    const html = render({ status: "signed-out", server }, ["dev"]);
    expect(html).toContain("Sign in (dev server)");
    expect(html).not.toContain("Sign in with Google");
    const olderServer = render({ status: "signed-out", server }, ["google", "github"]);
    expect(olderServer).toContain("Sign in with Google");
    expect(olderServer).toContain("Sign in with GitHub");
    expect(olderServer).not.toContain("Sign in with Apple");
  });

  test("puts Apple first when advertised and skips unknown providers", () => {
    const html = render({ status: "signed-out", server }, [
      "github",
      "future-provider",
      "google",
      "dev",
      "apple",
    ]);
    const providers = Array.from(
      html.matchAll(/data-provider="([^"]+)"/g),
      ([, provider]) => provider,
    );
    expect(providers).toEqual(["apple", "google", "github", "dev"]);
    expect(html).toContain("Sign in with Apple");
  });

  test.each([
    ["github-light", "bg-black", "text-white"],
    ["github-dark", "bg-white", "text-black"],
  ] as const)("uses the Apple button colors in %s", (resolved, background, text) => {
    const state = theme.useThemeStore.getInitialState();
    const readTheme = spyOn(theme, "useThemeStore").mockImplementation((select) =>
      select({ ...state, resolved }),
    );
    try {
      const html = render({ status: "signed-out", server }, ["apple"]);
      expect(html).toContain(` ${background} `);
      expect(html).toContain(` ${text} `);
      expect(html).toContain(" h-10 ");
      expect(html).toContain('viewBox="17 14.5 22 22"');
    } finally {
      readTheme.mockRestore();
    }
  });

  test("marks the dev sign-in as local only", () => {
    const html = render({ status: "signed-out", server }, ["google", "github", "dev"]);
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

  test("once signed in, shows a relay address and offers the sign-out", () => {
    const email = "relay-user@privaterelay.appleid.com";
    const html = render({
      status: "signed-in",
      server,
      user: { id: "u1", email, name: "Me" },
      device: { id: "d1", name: "Mac", platform: "darwin" },
    });
    expect(html).toContain("Me");
    expect(html).toContain(email);
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
    expect(html).toContain("be undone.");
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

const { VoiceUsageMeters, percentOf, usageResetsAt } = await import(
  "../../../../../src/renderer/components/settings/panels/remote-voice-group"
);

describe("the remote panel's voice usage", () => {
  const usage = {
    period: "2026-11",
    usedSeconds: 39 * 60,
    limitSeconds: 600 * 60,
    note: { usedSeconds: 50 * 60, limitSeconds: 1200 * 60 },
  };

  test("shows dictation and note recording apart, each with its share", () => {
    const html = renderToStaticMarkup(<VoiceUsageMeters usage={usage} />);
    expect(html).toContain("This month&#x27;s usage");
    expect(html).toContain("Resets ");
    expect(html).toContain("Dictation");
    expect(html).toContain("39 / 600 min · 7%");
    expect(html).toContain("Note recording");
    expect(html).toContain("50 / 1200 min · 4%");
    expect(html).toContain('aria-valuenow="7"');
    expect(html).toContain('aria-valuenow="4"');
    expect(html).not.toContain("bg-destructive");
  });

  test("leaves notes out when the server does not count them, and turns red near the limit", () => {
    const html = renderToStaticMarkup(
      <VoiceUsageMeters
        usage={{ period: "2026-11", usedSeconds: 545 * 60, limitSeconds: 36000 }}
      />,
    );
    expect(html).not.toContain("Note recording");
    expect(html).toContain("545 / 600 min · 91%");
    expect(html).toContain("bg-destructive");
  });

  test("says when it is loading or did not load", () => {
    expect(renderToStaticMarkup(<VoiceUsageMeters usage={null} />)).toContain("Loading…");
    const failed = renderToStaticMarkup(<VoiceUsageMeters usage="unavailable" />);
    expect(failed).toContain("Couldn&#x27;t load the usage.");
    expect(failed).not.toContain("progressbar");
  });

  test("counts any use as at least 1%, and no more than 100%", () => {
    expect(percentOf(0, 36000)).toBe(0);
    expect(percentOf(10, 36000)).toBe(1);
    expect(percentOf(39 * 60, 36000)).toBe(7);
    expect(percentOf(40000, 36000)).toBe(100);
    expect(percentOf(5, 0)).toBe(100);
  });

  test("starts over on the next month's first, in UTC", () => {
    expect(usageResetsAt("2026-11")?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(usageResetsAt("2026-12")?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(usageResetsAt("soon")).toBeNull();
  });
});
