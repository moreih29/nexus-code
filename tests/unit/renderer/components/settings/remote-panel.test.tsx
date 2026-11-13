import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteAccountState } from "../../../../../src/shared/remote/account";

const { AccountGroup, DeviceRow } = await import(
  "../../../../../src/renderer/components/settings/panels/remote-panel"
);

const server = "http://localhost:8787";
const render = (state: RemoteAccountState) => renderToStaticMarkup(<AccountGroup state={state} />);

describe("the remote panel's account", () => {
  test("offers the sign-in, saying why the last one failed", () => {
    const html = render({ status: "signed-out", server, failure: "unverified_email" });
    expect(html).toContain("Sign in with Google");
    expect(html).toContain("This Google account&#x27;s email is not verified.");
    expect(html).toContain(`Server: ${server}`);
  });

  test("says nothing of a sign-in the user cancelled", () => {
    const html = render({ status: "signed-out", server, failure: "cancelled" });
    expect(html).toContain("Sign in with Google");
    expect(html).not.toContain('role="alert"');
  });

  test("while the browser is out, offers to stop waiting", () => {
    const html = render({ status: "signing-in", server });
    expect(html).toContain("Finish signing in in your browser");
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
  });

  test("names each device's system, and tags this one", () => {
    const html = renderToStaticMarkup(
      <DeviceRow
        device={{ id: "d1", name: "Work PC", platform: "win32" }}
        current
        onRemove={() => {}}
      />,
    );
    expect(html).toContain("Work PC");
    expect(html).toContain("Windows");
    expect(html).toContain("This device");
    expect(html).toContain('aria-label="Remove Work PC"');
  });
});
