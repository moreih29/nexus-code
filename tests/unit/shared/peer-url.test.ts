import { describe, expect, test } from "bun:test";
import {
  buildPeerDirUrl,
  buildPeerUrl,
  peerFileOf,
  peerOf,
  peerWorkspaceId,
} from "../../../src/shared/fs/peer-url";

describe("another computer's workspace, as the previews name it", () => {
  test("by both of its ids, which come back out; a workspace here's id names none", () => {
    const id = peerWorkspaceId("0a18c073-ed05", "8dd9f4b1-c920");
    expect(peerOf(id)).toEqual({ deviceId: "0a18c073-ed05", workspaceId: "8dd9f4b1-c920" });
    expect(peerOf("8dd9f4b1-c920-466d-baa0-e0398cedf476")).toBeNull();
    expect(peerOf("peer:a:b:c")).toBeNull();
    expect(peerOf("peer::b")).toBeNull();
  });

  test("its files' URLs carry their paths there, POSIX or Windows, and read back", () => {
    const peer = { deviceId: "d", workspaceId: "w" };
    const posix = buildPeerUrl(peer, "/home/me/a b.png");
    expect(posix).toBe("nexus-workspace://peer/d/w/home/me/a%20b.png");
    const windows = buildPeerUrl(peer, "C:\\Users\\me\\x.pdf");
    expect(windows).toBe("nexus-workspace://peer/d/w/C%3A/Users/me/x.pdf");
    expect(buildPeerDirUrl(peer, "/home/me/")).toBe("nexus-workspace://peer/d/w/home/me/");
    const back = (url: string) =>
      peerFileOf(new URL(url).pathname.slice(1).split("/").map(decodeURIComponent));
    expect(back(posix)).toEqual({ peer, absPath: "/home/me/a b.png" });
    expect(back(windows)).toEqual({ peer, absPath: "C:/Users/me/x.pdf" });
  });

  test("a URL whose path climbs out, or names no file, names none", () => {
    expect(peerFileOf(["d", "w", "home", "..", "etc"])).toBeNull();
    expect(peerFileOf(["d", "w"])).toBeNull();
    expect(peerFileOf(["d", "w", "a", ""])).toBeNull();
    expect(peerFileOf(["d/x", "w", "a"])).toBeNull();
    expect(peerFileOf(["d", "w", "home", "../etc"])).toBeNull();
    expect(peerFileOf(["d", "w", "C:", "a\\..\\b"])).toBeNull();
  });
});
