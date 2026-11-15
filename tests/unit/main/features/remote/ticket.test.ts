/** The socket's ticket, asked with the relay version this app speaks. */
import { describe, expect, test } from "bun:test";
import { RELAY_VERSION } from "../../../../../packages/remote-protocol/src";
import {
  OutdatedError,
  ServerError,
  SignedOutError,
} from "../../../../../src/main/features/remote/errors";
import { askTicket } from "../../../../../src/main/features/remote/ticket";

function account(answer: () => Promise<unknown>) {
  const asked: { method: string; path: string; body: unknown }[] = [];
  return {
    asked,
    request: async (method: string, path: string, body?: unknown) => {
      asked.push({ method, path, body });
      return answer();
    },
  };
}

describe("askTicket", () => {
  test("asks with the relay version, the body as given", async () => {
    const a = account(async () => ({ ticket: "t-1", expiresAt: 1 }));
    expect(await askTicket(a, { voiceTerms: ["x"] })).toBe("t-1");
    expect(a.asked).toEqual([
      { method: "POST", path: `/relay/ticket?v=${RELAY_VERSION}`, body: { voiceTerms: ["x"] } },
    ]);
    expect(RELAY_VERSION).toBe(2);
  });

  test("a version the server no longer takes is OutdatedError", async () => {
    const a = account(async () => {
      throw new ServerError(400, "unsupported_version", "POST /relay/ticket");
    });
    await expect(askTicket(a)).rejects.toBeInstanceOf(OutdatedError);
  });

  test("any other failure is passed on as it came", async () => {
    const other = new ServerError(400, "bad_request", "POST /relay/ticket");
    await expect(askTicket(account(async () => Promise.reject(other)))).rejects.toBe(other);
    const out = new SignedOutError();
    await expect(askTicket(account(async () => Promise.reject(out)))).rejects.toBe(out);
    await expect(askTicket(account(async () => ({ nope: true })))).rejects.toThrow();
  });
});
