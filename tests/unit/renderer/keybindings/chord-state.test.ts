import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  __resetForTests,
  __setClockForTests,
  clearPending,
  enterPending,
  getPendingLeader,
  isModifierKeyOnly,
  isPending,
  purgeExpired,
} from "../../../../src/renderer/keybindings/chord-state";

beforeEach(() => __resetForTests());
afterEach(() => __resetForTests());

describe("chord-state", () => {
  it("starts idle", () => {
    expect(isPending()).toBe(false);
    expect(getPendingLeader()).toBeNull();
  });

  it("enterPending arms the leader", () => {
    enterPending("CmdOrCtrl+K");
    expect(isPending()).toBe(true);
    expect(getPendingLeader()).toBe("CmdOrCtrl+K");
  });

  it("clearPending returns to idle", () => {
    enterPending("CmdOrCtrl+K");
    clearPending();
    expect(isPending()).toBe(false);
  });

  it("purgeExpired returns false while not pending", () => {
    expect(purgeExpired()).toBe(false);
  });

  it("purgeExpired returns false before the timeout elapses", () => {
    let now = 1_000;
    __setClockForTests(() => now);
    enterPending("CmdOrCtrl+K", 1500);
    now += 1499;
    expect(purgeExpired()).toBe(false);
    expect(isPending()).toBe(true);
  });

  it("purgeExpired clears the state once the timeout has passed", () => {
    let now = 1_000;
    __setClockForTests(() => now);
    enterPending("CmdOrCtrl+K", 1500);
    now += 2_000;
    expect(purgeExpired()).toBe(true);
    expect(isPending()).toBe(false);
  });

  it("re-entering a leader resets the timeout", () => {
    let now = 1_000;
    __setClockForTests(() => now);
    enterPending("CmdOrCtrl+K", 1500);
    now += 1_400;
    enterPending("CmdOrCtrl+K", 1500);
    now += 1_400; // 2800 since first enter, but only 1400 since re-enter
    expect(purgeExpired()).toBe(false);
  });
});

describe("isModifierKeyOnly", () => {
  function ke(key: string): KeyboardEvent {
    return { key } as unknown as KeyboardEvent;
  }
  it("recognises bare Meta / Control / Shift / Alt", () => {
    expect(isModifierKeyOnly(ke("Meta"))).toBe(true);
    expect(isModifierKeyOnly(ke("Control"))).toBe(true);
    expect(isModifierKeyOnly(ke("Shift"))).toBe(true);
    expect(isModifierKeyOnly(ke("Alt"))).toBe(true);
  });
  it("returns false for letter keys", () => {
    expect(isModifierKeyOnly(ke("k"))).toBe(false);
    expect(isModifierKeyOnly(ke("W"))).toBe(false);
  });
});
