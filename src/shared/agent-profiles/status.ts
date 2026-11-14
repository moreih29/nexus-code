/** Who a profile is signed in as, as Settings shows it. */

import { z } from "zod";

export const AgentProfileStatusSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("signed-in"),
    /** How: "claude.ai", "console", "chatgpt", "apikey"… */
    method: z.string().optional(),
    email: z.string().optional(),
    /** Claude's organization. */
    orgId: z.string().optional(),
    orgName: z.string().optional(),
    /** "max", "team", "plus"… */
    plan: z.string().optional(),
    /** Codex's ChatGPT account, to tell two profiles of one account. */
    accountId: z.string().optional(),
  }),
  z.object({ state: z.literal("signed-out") }),
  /**
   * The agent's program was not found ("missing"), or gave nothing to read
   * when asked who is signed in ("no-answer"). With no reason the sign-in
   * could not be checked for another one, which `message` gives.
   */
  z.object({
    state: z.literal("unavailable"),
    message: z.string(),
    reason: z.enum(["missing", "no-answer"]).optional(),
  }),
]);
export type AgentProfileStatus = z.infer<typeof AgentProfileStatusSchema>;

/**
 * Whether Claude's organization name is the one its server makes of an
 * email ("someone@example.com's Organization"): a personal organization,
 * which reads better by that word.
 */
export function isPersonalOrgName(name: string | undefined, email?: string): boolean {
  if (!name) return false;
  if (email && name === `${email}'s Organization`) return true;
  return /^[^\s@]+@[^\s@]+'s Organization$/.test(name);
}

/** What `claude auth status --json` says, read leniently. */
export function claudeStatusOf(stdout: string): z.infer<typeof AgentProfileStatusSchema> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const str = (key: string) =>
    typeof r[key] === "string" && r[key] !== "" ? (r[key] as string) : undefined;
  if (r.loggedIn !== true) return { state: "signed-out" };
  const status: z.infer<typeof AgentProfileStatusSchema> = { state: "signed-in" };
  const fields = {
    method: str("authMethod"),
    email: str("email"),
    orgId: str("orgId"),
    orgName: str("orgName"),
    plan: str("subscriptionType"),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) (status as Record<string, unknown>)[key] = value;
  }
  return status;
}

/** The claims of a JWT, unverified: only to show who signed in. */
function jwtClaims(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const json = atob(
      part
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(part.length / 4) * 4, "="),
    );
    const claims = JSON.parse(json) as unknown;
    return typeof claims === "object" && claims !== null
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** What Codex's auth.json says of its sign-in; null when it says nothing readable. */
export function codexStatusOf(authJson: string): z.infer<typeof AgentProfileStatusSchema> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(authJson);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const tokens = r.tokens as Record<string, unknown> | null | undefined;
  const idToken = typeof tokens?.id_token === "string" ? tokens.id_token : undefined;
  if (idToken) {
    const claims = jwtClaims(idToken) ?? {};
    const auth = (claims["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
    const status: z.infer<typeof AgentProfileStatusSchema> = {
      state: "signed-in",
      method: "chatgpt",
    };
    if (typeof claims.email === "string") status.email = claims.email;
    if (typeof auth.chatgpt_plan_type === "string") status.plan = auth.chatgpt_plan_type;
    const account = auth.chatgpt_account_id ?? tokens?.account_id;
    if (typeof account === "string") status.accountId = account;
    return status;
  }
  if (typeof r.OPENAI_API_KEY === "string" && r.OPENAI_API_KEY !== "") {
    return { state: "signed-in", method: "apikey" };
  }
  return { state: "signed-out" };
}
