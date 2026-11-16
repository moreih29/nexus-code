/**
 * Whether another device speaks a protocol version: one before 0.13.1 drops
 * terminal.open's `profile`, so its terminals do not sign a chat's profile in.
 */
import { describe, expect, test } from "bun:test";
import type { RoomPeer } from "../../../../../src/shared/remote/room";

const { chatProfileIdThere, peerSpeaks, TERMINAL_PROFILE_SCHEMA } = await import(
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

describe("the profile there a chat runs with", () => {
  const one = [{ id: "codex-default", name: "default" }];
  const two = [...one, { id: "codex-ab12", name: "Work" }];

  test("by the chat's profile's name", () => {
    expect(chatProfileIdThere("Work", two)).toBe("codex-ab12");
    expect(chatProfileIdThere("default", two)).toBe("codex-default");
  });

  test("with no name, the agent's only profile: a session names one only where there are more", () => {
    expect(chatProfileIdThere(undefined, one)).toBe("codex-default");
  });

  test("never a guess: no name with more than one, or a name none or two have", () => {
    expect(() => chatProfileIdThere(undefined, two)).toThrow("not known here");
    expect(() => chatProfileIdThere(undefined, [])).toThrow("not known here");
    expect(() => chatProfileIdThere("Gone", two)).toThrow(/no one profile "Gone"/);
    expect(() => chatProfileIdThere("Work", [...two, { id: "codex-cd34", name: "Work" }])).toThrow(
      /no one profile "Work"/,
    );
  });
});
