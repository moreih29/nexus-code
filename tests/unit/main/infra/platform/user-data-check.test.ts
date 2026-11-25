import { describe, expect, test } from "bun:test";
import {
  hasUserData,
  type UserDataApp,
  userDataUnavailableText,
} from "../../../../../src/main/infra/platform/user-data-check";

function appWith(getPath: UserDataApp["getPath"]): UserDataApp {
  return { getPath };
}

describe("hasUserData", () => {
  test("is true when Electron gives the user data folder", () => {
    expect(hasUserData(appWith(() => "C:UsersmeAppDataRoamingNexusCode"))).toBe(true);
  });

  test("is false when Electron cannot give it", () => {
    const app = appWith(() => {
      throw new Error("Failed to get 'userData' path");
    });
    expect(hasUserData(app)).toBe(false);
  });
});

describe("userDataUnavailableText", () => {
  test("speaks Korean on a Korean system and English elsewhere, without a path", () => {
    const ko = userDataUnavailableText("ko-KR");
    const en = userDataUnavailableText("en-US");
    expect(ko.title).toBe("NexusCode를 시작할 수 없습니다");
    expect(en.title).toBe("NexusCode can't start");
    expect(userDataUnavailableText("de-DE")).toEqual(en);
    for (const text of [ko.message, en.message]) {
      expect(text).not.toMatch(/[/]/);
    }
  });
});
