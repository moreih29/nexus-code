import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import i18next from "i18next";
import { act } from "react";
import { ChatLinksContext } from "../../../../../src/renderer/components/chat/chat-links";
import { ChatMarkdown } from "../../../../../src/renderer/components/chat/chat-markdown";
import * as toasts from "../../../../../src/renderer/components/ui/toast";
import * as ipc from "../../../../../src/renderer/ipc/client";
import {
  isUnknownFile,
  pathToLookUp,
} from "../../../../../src/renderer/services/chat/file-presence";
import { useLocalChatLinks } from "../../../../../src/renderer/services/chat/local-chat-links";
import { setPlatformForTests } from "../../../../../src/renderer/utils/platform";
import { ipcOk } from "../../../../../src/shared/ipc/result";
import { withTestDom } from "../../../../helpers/test-dom";

type Call = { domain: string; channel: string; args: unknown };

let calls: Call[] = [];
let toastsShown: unknown[] = [];
const restore: { mockRestore(): void }[] = [];

beforeEach(() => {
  calls = [];
  toastsShown = [];
  restore.push(
    spyOn(ipc, "ipcCallResult").mockImplementation(((
      domain: string,
      channel: string,
      args: unknown,
    ) => {
      calls.push({ domain, channel, args });
      return Promise.resolve(ipcOk(undefined));
    }) as never),
    spyOn(ipc, "ipcStream").mockImplementation(((domain: string, channel: string) => {
      calls.push({ domain, channel, args: null });
      throw new Error("no stream in this test");
    }) as never),
    spyOn(toasts, "showToast").mockImplementation(((input: unknown) => {
      toastsShown.push(input);
      return 0;
    }) as never),
  );
});

afterEach(() => {
  for (const spy of restore.splice(0)) spy.mockRestore();
  setPlatformForTests(null);
});

function Chat({
  text,
  workspaceId,
  root,
  seen,
}: {
  text: string;
  workspaceId: string;
  root: string;
  seen: (files: readonly string[] | null) => void;
}) {
  const { links, look } = useLocalChatLinks({
    workspaceId,
    tabId: "t",
    cwd: root,
    rootPath: root,
    visible: true,
    source: SOURCE,
    tasks: {},
    split: () => true,
    changesOf: () => undefined,
  });
  seen(look?.files ?? null);
  return (
    <ChatLinksContext.Provider value={links}>
      <ChatMarkdown text={text} workspaceId={workspaceId} cwd={root} rootPath={root} />
    </ChatLinksContext.Provider>
  );
}

const SOURCE = { items: [], tools: {}, agentItems: {} };

const ANSWER = [
  "See [shot](/net/h/s/a.png), [other](/net/h/s/b.png),",
  "[notes](/Network/s/a.txt) and [data](/System/Volumes/Data/net/h/s/c.txt).",
].join(" ");

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function drawn(
  root: string,
  text: string,
  run: (
    host: HTMLElement,
    looks: (readonly string[] | null)[],
    workspaceId: string,
  ) => Promise<void>,
) {
  const workspaceId = crypto.randomUUID();
  const looks: (readonly string[] | null)[] = [];
  await withTestDom(async (host, view) => {
    await act(async () =>
      view.render(
        <Chat
          text={text}
          workspaceId={workspaceId}
          root={root}
          seen={(files) => looks.push(files)}
        />,
      ),
    );
    await settle();
    await run(host, looks, workspaceId);
  });
}

function linkTo(host: HTMLElement, href: string): HTMLAnchorElement {
  const link = Array.from(host.querySelectorAll("a")).find((a) => a.getAttribute("href") === href);
  if (!link) throw new Error(`no link to ${href} in ${host.innerHTML}`);
  return link;
}

async function click(link: HTMLAnchorElement) {
  await act(async () => link.click());
  await settle();
  await settle();
}

function grantsSent(): Call[] {
  return calls.filter((call) => call.channel === "grantOutside");
}

describe("a link to an automount path in an answer", () => {
  test.each([
    "darwin",
    "linux",
  ] as const)("is drawn as a link on %s without asking anything", async (platform) => {
    setPlatformForTests(platform);
    await drawn("/Users/me/w", ANSWER, async (host) => {
      for (const href of [
        "/net/h/s/a.png",
        "/net/h/s/b.png",
        "/Network/s/a.txt",
        "/System/Volumes/Data/net/h/s/c.txt",
      ]) {
        expect(linkTo(host, href).textContent).not.toBe("");
      }
      expect(host.querySelectorAll("span[title]")).toHaveLength(0);
    });
    expect(calls).toEqual([]);
  });

  test("grants only the clicked image, as opened, and shows it", async () => {
    setPlatformForTests("darwin");
    await drawn("/Users/me/w", ANSWER, async (host, looks, workspaceId) => {
      expect(calls).toEqual([]);
      await click(linkTo(host, "/net/h/s/a.png"));
      expect(looks.at(-1)).toEqual(["/net/h/s/a.png"]);
      expect(grantsSent()).toEqual([
        {
          domain: "fs",
          channel: "grantOutside",
          args: { workspaceId, owner: "t", files: [], dirs: [], opened: ["/net/h/s/a.png"] },
        },
      ]);
      expect(calls.filter((call) => call.channel !== "grantOutside")).toEqual([]);
    });
  });

  test("grants a clicked text file on its own and opens it in the quick look", async () => {
    setPlatformForTests("darwin");
    await drawn("/Users/me/w", ANSWER, async (host, looks, workspaceId) => {
      await click(linkTo(host, "/Network/s/a.txt"));
      expect(looks.at(-1)).toEqual(["/Network/s/a.txt"]);
      await click(linkTo(host, "/net/h/s/b.png"));
      expect(looks.at(-1)).toEqual(["/net/h/s/b.png"]);
      expect(grantsSent().map((call) => call.args)).toEqual([
        { workspaceId, owner: "t", files: [], dirs: [], opened: ["/Network/s/a.txt"] },
        {
          workspaceId,
          owner: "t",
          files: [],
          dirs: [],
          opened: ["/Network/s/a.txt", "/net/h/s/b.png"],
        },
      ]);
    });
  });

  test("an ordinary outside link that is not found yet stays text", async () => {
    setPlatformForTests("darwin");
    await drawn("/Users/me/w", "See [gone](/tmp/qa-none/a.txt).", async (host) => {
      expect(host.querySelectorAll("a")).toHaveLength(0);
    });
    expect(calls.map((call) => call.channel)).toEqual(["outsideExists"]);
  });
});

describe("network links on Windows", () => {
  test("still say a network path is not opened, and grant nothing", async () => {
    setPlatformForTests("win32");
    await drawn("C:/w", "See [share](//server/share/a.txt).", async (host, looks) => {
      await click(linkTo(host, "//server/share/a.txt"));
      expect(toastsShown).toEqual([
        { kind: "error", message: i18next.t("chat.links.network_path") },
      ]);
      expect(looks.every((files) => files === null)).toBe(true);
    });
    expect(calls).toEqual([]);
  });

  test("an automount path beside a Windows drive workspace is still not a link", async () => {
    setPlatformForTests("win32");
    await drawn("C:/w", "See [shot](/net/h/s/a.png).", async (host) => {
      expect(host.querySelectorAll("a")).toHaveLength(0);
    });
    expect(calls).toEqual([]);
    expect(isUnknownFile("/net/h/s/a.png", "C:/w")).toBe(false);
    expect(isUnknownFile("/net/h/s/a.png", "//nas/share/w")).toBe(false);
  });
});

describe("which paths are unknown rather than gone", () => {
  test("only automount paths outside the root that would otherwise be looked up", () => {
    expect(isUnknownFile("/net/h/s/a.png", "/p")).toBe(true);
    expect(isUnknownFile("/Network/s/a.txt", "/p")).toBe(true);
    expect(isUnknownFile("/tmp/../net/h/a.txt", "/p")).toBe(true);
    expect(isUnknownFile("/net/host/w/src/a.ts", "/net/host/w")).toBe(false);
    expect(pathToLookUp("/net/host/w/src/a.ts", "/net/host/w")).toBe("src/a.ts");
    expect(isUnknownFile("/tmp/a.txt", "/p")).toBe(false);
    expect(isUnknownFile("/net/h/a.txt", "")).toBe(false);
    expect(isUnknownFile("//server/share/a.txt", "/p")).toBe(false);
    expect(isUnknownFile("/??/UNC/net/a.txt", "/p")).toBe(false);
  });
});
