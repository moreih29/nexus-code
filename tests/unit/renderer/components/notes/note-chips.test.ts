import { afterEach, expect, test } from "bun:test";
import i18next from "i18next";
import { noteChips } from "../../../../../src/renderer/components/notes/notes-panel";
import { clockOf } from "../../../../../src/shared/notes/transcript";

const counts = { sketches: 0, files: 0, images: 0, todos: 0, todosDone: 0 };
const chip = (ms: number, people = 1) => noteChips({ counts, recording: { ms, people } })[0];

afterEach(() => i18next.changeLanguage("en"));

test("a recording under a minute shows its seconds, as the clock does", () => {
  expect(chip(6_000)).toBe("Recording 6 s");
  expect(chip(6_900)).toBe("Recording 6 s");
  expect(chip(59_999)).toBe("Recording 59 s");
  expect(chip(400)).toBe("Recording 0 s");
  expect(chip(6_000, 2)).toBe("Meeting 6 s");
  expect(clockOf(6_900)).toBe("0:06");
});

test("a recording of a minute or more shows whole minutes, cut down like the clock", () => {
  expect(chip(60_000)).toBe("Recording 1 min");
  expect(chip(119_999)).toBe("Recording 1 min");
  expect(clockOf(119_999)).toBe("1:59");
  expect(chip(150_000, 3)).toBe("Meeting 2 min");
});

test("in Korean too", async () => {
  await i18next.changeLanguage("ko");
  expect(chip(6_000)).toBe("녹음 6초");
  expect(chip(6_000, 2)).toBe("회의 6초");
  expect(chip(90_000)).toBe("녹음 1분");
});
