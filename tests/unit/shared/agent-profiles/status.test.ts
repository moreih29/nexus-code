import { describe, expect, test } from "bun:test";
import {
  claudeStatusOf,
  codexStatusOf,
  isPersonalOrgName,
} from "../../../../src/shared/agent-profiles/status";

function jwt(claims: object): string {
  const part = btoa(JSON.stringify(claims))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `e30.${part}.sig`;
}

describe("claudeStatusOf", () => {
  test("a sign-in: its organization and plan", () => {
    const status = claudeStatusOf(
      JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        email: "me@example.com",
        orgId: "org-1",
        orgName: "RTM",
        subscriptionType: "team",
      }),
    );
    expect(status).toEqual({
      state: "signed-in",
      method: "claude.ai",
      email: "me@example.com",
      orgId: "org-1",
      orgName: "RTM",
      plan: "team",
    });
  });

  test("signed out, and output that is not JSON", () => {
    expect(claudeStatusOf('{"loggedIn": false, "authMethod": "none"}')).toEqual({
      state: "signed-out",
    });
    expect(claudeStatusOf("command not found")).toBeNull();
  });
});

describe("codexStatusOf", () => {
  test("a ChatGPT sign-in: the id token's email, plan and account", () => {
    const idToken = jwt({
      email: "me@example.com",
      "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_account_id: "acct-1" },
    });
    expect(
      codexStatusOf(JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: idToken } })),
    ).toEqual({
      state: "signed-in",
      method: "chatgpt",
      email: "me@example.com",
      plan: "plus",
      accountId: "acct-1",
    });
  });

  test("an API key, and nothing", () => {
    expect(codexStatusOf('{"OPENAI_API_KEY": "sk-x"}')).toEqual({
      state: "signed-in",
      method: "apikey",
    });
    expect(codexStatusOf('{"OPENAI_API_KEY": null, "tokens": null}')).toEqual({
      state: "signed-out",
    });
    expect(codexStatusOf("{")).toBeNull();
  });
});

test("an organization named after an email is a personal one", () => {
  expect(isPersonalOrgName("me@example.com's Organization", "me@example.com")).toBe(true);
  expect(isPersonalOrgName("someone@x.io's Organization")).toBe(true);
  expect(isPersonalOrgName("RTM", "me@example.com")).toBe(false);
  expect(isPersonalOrgName(undefined)).toBe(false);
});
