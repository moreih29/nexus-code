/**
 * Whether another device speaks a protocol version: one before 0.13.1 drops
 * terminal.open's `profile`, so its terminals do not sign a chat's profile in.
 */
import { describe, expect, test } from "bun:test";
import type { RoomPeer } from "../../../../../src/shared/remote/room";

const { peerSpeaks, TERMINAL_PROFILE_SCHEMA } = await import(
  "../../../../../src/renderer/services/remote/room"
);

const peer = (schema?: string): RoomPeer => ({
  id: "p",
  name: "PC",
  platform: "win32",
  online: true,
  serves: ["sessions", "terminal.control"],
  ...(schema ? { schema } : {}),
});

describe("a peer's protocol version", () => {
  test("from 0.13.1 on, its terminals open in a chat's profile", () => {
    expect(TERMINAL_PROFILE_SCHEMA).toBe("0.13.1");
    expect(peerSpeaks(peer("0.13.1"), TERMINAL_PROFILE_SCHEMA)).toBe(true);
    expect(peerSpeaks(peer("0.14.0"), TERMINAL_PROFILE_SCHEMA)).toBe(true);
    expect(peerSpeaks(peer("1.0.0"), TERMINAL_PROFILE_SCHEMA)).toBe(true);
  });

  test("not before, nor before its hello said, nor a device not in the room", () => {
    expect(peerSpeaks(peer("0.13.0"), TERMINAL_PROFILE_SCHEMA)).toBe(false);
    expect(peerSpeaks(peer("0.9.9"), TERMINAL_PROFILE_SCHEMA)).toBe(false);
    expect(peerSpeaks(peer(), TERMINAL_PROFILE_SCHEMA)).toBe(false);
    expect(peerSpeaks(undefined, TERMINAL_PROFILE_SCHEMA)).toBe(false);
  });
});
