import { expect, test } from "bun:test";
import { LOG_FILE_MAX_BYTES } from "../../../src/shared/log/main";

test("a log file is capped at 2 MB", () => {
  expect(LOG_FILE_MAX_BYTES).toBe(2 * 1024 * 1024);
});
