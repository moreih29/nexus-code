import { describe, expect, test } from "bun:test";
import {
  type ListedWorkspaces,
  listedComputers,
  NAMES_ASK_MS,
  NAMES_FRESH_MS,
  type NamedComputer,
  VoiceNames,
  voiceNamesOf,
} from "../../../../../src/main/features/remote/voice-names";
import { clipTerm } from "../../../../../src/shared/remote/voice";

describe("the names a voice session sends", () => {
  test("keep their order, trimmed, each once whatever its case, the empty ones out", () => {
    expect(
      voiceNamesOf([
        ["Mac Studio", " Work PC "],
        ["api-server", "", "  ", "mac studio"],
        ["API-Server", "docs"],
      ]),
    ).toEqual(["Mac Studio", "Work PC", "api-server", "docs"]);
  });

  test("are at most 60, each at most 80 characters", () => {
    const many = Array.from({ length: 100 }, (_, i) => `ws-${i}`);
    const names = voiceNamesOf([many]);
    expect(names).toHaveLength(60);
    expect(names[59]).toBe("ws-59");
    expect(voiceNamesOf([["a".repeat(120)]])).toEqual(["a".repeat(80)]);
    expect(voiceNamesOf([[`${"b".repeat(80)}1`, `${"b".repeat(80)}2`]])).toHaveLength(1);
  });

  test("a clipped name keeps whole characters", () => {
    const name = `${"a".repeat(79)}😀`;
    expect(clipTerm(name)).toBe("a".repeat(79));
    expect(clipTerm("한글 이름")).toBe("한글 이름");
  });
});

describe("the computers the names come from", () => {
  const peer = (
    id: string,
    online: boolean,
    platform = "darwin",
    serves: string[] | null = ["sessions"],
  ) => ({ id, name: `Computer ${id}`, platform, online, ...(serves ? { serves } : {}) });

  test("are those of the Other computers list: serving in the room, or desktops out of it", () => {
    const computers = listedComputers({
      status: "online",
      peers: [
        peer("a", true),
        peer("b", false),
        peer("c", false, "ios"),
        peer("d", true, "android", ["chat.control"]),
        peer("e", true, "linux", null),
      ],
    });
    expect(computers).toEqual([
      { id: "a", name: "Computer a", serving: true },
      { id: "b", name: "Computer b", serving: false },
    ]);
  });

  test("none while this computer is out of the room", () => {
    expect(listedComputers({ status: "connecting", peers: [peer("a", true)] })).toEqual([]);
  });
});

describe("gathering the names", () => {
  function setup(options: {
    enabled?: boolean;
    workspaces?: string[];
    computers?: NamedComputer[];
    list?: (deviceId: string, timeoutMs: number) => Promise<ListedWorkspaces>;
  }) {
    let now = 1_000_000;
    const asked: { deviceId: string; timeoutMs: number }[] = [];
    const names = new VoiceNames({
      enabled: () => options.enabled ?? true,
      workspaces: () => options.workspaces ?? [],
      computers: () => options.computers ?? [],
      list: async (deviceId, timeoutMs) => {
        asked.push({ deviceId, timeoutMs });
        return options.list ? options.list(deviceId, timeoutMs) : { workspaces: [] };
      },
      now: () => now,
    });
    return { names, asked, later: (ms: number) => (now += ms) };
  }

  test("none while the user has not turned them on, and no computer is asked", async () => {
    const { names, asked } = setup({
      enabled: false,
      workspaces: ["local"],
      computers: [{ id: "a", name: "Work PC", serving: true }],
    });
    expect(await names.collect()).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("the computers' names, this computer's workspaces, then theirs", async () => {
    const { names, asked } = setup({
      workspaces: ["api-server", "docs"],
      computers: [
        { id: "a", name: "Work PC", serving: true },
        { id: "b", name: "Old Laptop", serving: false },
      ],
      list: async () => ({ workspaces: [{ name: "backend" }, { name: "Docs" }] }),
    });
    expect(await names.collect()).toEqual([
      "Work PC",
      "Old Laptop",
      "api-server",
      "docs",
      "backend",
    ]);
    expect(asked).toEqual([{ deviceId: "a", timeoutMs: NAMES_ASK_MS }]);
  });

  test("a list that came lately is used as it is; an old one is asked again", async () => {
    const { names, asked, later } = setup({
      computers: [{ id: "a", name: "Work PC", serving: true }],
      list: async () => ({ workspaces: [{ name: "fresh" }] }),
    });
    names.took("a", { workspaces: [{ name: "watched" }] });
    expect(await names.collect()).toEqual(["Work PC", "watched"]);
    expect(asked).toEqual([]);
    later(NAMES_FRESH_MS + 1);
    expect(await names.collect()).toEqual(["Work PC", "fresh"]);
    expect(asked).toHaveLength(1);
  });

  test("a computer that does not answer keeps the list it gave, or gives none", async () => {
    const { names, later } = setup({
      computers: [
        { id: "a", name: "Work PC", serving: true },
        { id: "b", name: "Home PC", serving: true },
      ],
      list: async () => {
        throw new Error("timed out");
      },
    });
    names.took("a", { workspaces: [{ name: "kept" }] });
    later(NAMES_FRESH_MS + 1);
    expect(await names.collect()).toEqual(["Work PC", "Home PC", "kept"]);
  });

  test("an offline computer's workspaces, listed while it was here, still go", async () => {
    const { names, asked } = setup({
      computers: [{ id: "b", name: "Old Laptop", serving: false }],
    });
    names.took("b", { workspaces: [{ name: "thesis" }] });
    expect(await names.collect()).toEqual(["Old Laptop", "thesis"]);
    expect(asked).toEqual([]);
  });
});

describe("gathering the names when asking fails at once", () => {
  test("a computer that cannot be asked at all leaves the other names", async () => {
    const names = new VoiceNames({
      enabled: () => true,
      workspaces: () => ["local"],
      computers: () => [{ id: "a", name: "Work PC", serving: true }],
      list: () => {
        throw new Error("not in the room");
      },
    });
    expect(await names.collect()).toEqual(["Work PC", "local"]);
  });
});
