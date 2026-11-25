import { afterAll, beforeEach, expect, it, mock } from "bun:test";

const calls: { method: string; args: unknown }[] = [];
let remembered: { workspaceId: string; origin: string; permission: string; decision: string }[] =
  [];

const CLIENT = "../../../../../src/renderer/ipc/client";
const previousClient = { ...(await import(CLIENT)) };
mock.module(CLIENT, () => ({
  ...previousClient,
  ipcCallResult: (channel: string, method: string, args: unknown) => {
    calls.push({ method: `${channel}.${method}`, args });
    if (method === "listRemembered") return Promise.resolve({ ok: true, value: remembered });
    return Promise.resolve({ ok: true, value: undefined });
  },
}));
afterAll(() => {
  mock.module(CLIENT, () => previousClient);
});

const { actionHandlers } = await import("../../../../../src/renderer/services/cli/actions");
const { useBrowserPermissionsStore } = await import(
  "../../../../../src/renderer/state/stores/browser-permissions"
);

const revoke = actionHandlers["browser.permissions.revoke"];

beforeEach(() => {
  calls.length = 0;
  remembered = [];
  useBrowserPermissionsStore.getState().hydrate({ media: true, geolocation: false });
});

it("turns a global permission off, and leaves one that is off alone", async () => {
  expect(await revoke({ scope: "global", permission: "media" })).toEqual({ revoked: ["media"] });
  expect(useBrowserPermissionsStore.getState().grants).toEqual({
    media: false,
    geolocation: false,
  });
  expect(await revoke({ scope: "global", permission: "geolocation" })).toEqual({ revoked: [] });
  expect(calls).toEqual([
    {
      method: "appState.set",
      args: { browserPermissionGrants: { media: false, geolocation: false } },
    },
  ]);
  await expect(revoke({ scope: "global", permission: "camera" })).rejects.toThrow(
    'no browser permission "camera"; the global ones are media,',
  );
});

it("forgets a site's remembered allow, and only an allow", async () => {
  remembered = [
    { workspaceId: "ws", origin: "https://a.test", permission: "media", decision: "allow" },
    { workspaceId: "ws", origin: "https://b.test", permission: "media", decision: "block" },
  ];
  const site = { scope: "site", workspaceId: "ws", permission: "media" } as const;
  expect(await revoke({ ...site, origin: "https://a.test" })).toEqual({ revoked: ["media"] });
  expect(calls.at(-1)).toEqual({
    method: "browserPermission.revoke",
    args: { workspaceId: "ws", origin: "https://a.test", permission: "media" },
  });
  await expect(revoke({ ...site, origin: "https://b.test" })).rejects.toThrow(
    "https://b.test is blocked from media; forgetting that would let it ask again",
  );
  await expect(revoke({ ...site, origin: "https://c.test" })).rejects.toThrow(
    "no remembered media decision for https://c.test",
  );
  expect(calls.filter(({ method }) => method === "browserPermission.revoke")).toHaveLength(1);
});
