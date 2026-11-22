/**
 * The app's NexusCode account, for the remote: who it is signed in as, on
 * which server, and this device as the server knows it.
 */
import { z } from "zod";
import {
  NumberSchema,
  PositiveIntegerSchema,
} from "../../../packages/remote-protocol/src/validation";

/** The sign-ins the app knows, in display order; GET /info says which to offer. */
export const SIGN_IN_PROVIDERS = ["apple", "google", "github", "dev"] as const;
export const SignInProviderSchema = z.enum(SIGN_IN_PROVIDERS);
export type SignInProvider = z.infer<typeof SignInProviderSchema>;

export const RemoteUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
});
export type RemoteUser = z.infer<typeof RemoteUserSchema>;

/** A device of the account, as the server knows it. */
export const RemoteDeviceInfoSchema = z.looseObject({
  id: z.string(),
  /** The name it signed in with (its host's). */
  name: z.string(),
  /** The name the user gave it, shown in its place; null or absent for none. */
  alias: z.string().nullable().optional(),
  platform: z.string(),
  /** When the device signed in, and when the server last heard from it, in Unix ms. */
  createdAt: NumberSchema.optional(),
  lastSeenAt: NumberSchema.optional(),
  /** Whether it is the device asking. */
  current: z.boolean().optional(),
});
export type RemoteDeviceInfo = z.infer<typeof RemoteDeviceInfoSchema>;

/** The longest alias a device is given (the server's limit). */
export const MAX_DEVICE_ALIAS = 64;

/** A device as the user knows it: its alias, or the name it signed in with. */
export function deviceLabel(device: { name: string; alias?: string | null }): string {
  return device.alias || device.name;
}

export const SIGNUP_FAILURES = ["pending_approval", "rejected", "suspended", "closed"] as const;

/**
 * Why a sign-in did not finish:
 * - cancelled, timed-out: the app stopped waiting for the browser;
 * - access_denied, unverified_email, server_error: the user declined, the
 *   provider has not verified the email, or the server failed;
 * - not_invited: the server refused access without giving a signup status;
 * - pending_approval, rejected, suspended, closed: the signup request awaits
 *   approval, was denied, the account was suspended, or signup is closed;
 *   an authenticated 403 not_invited also signs the account out, with
 *   suspended when the server gives that status;
 * - invalid_grant: the server would not trade the code (expired, or used);
 * - too_many_devices: the account has as many devices signed in as it may,
 *   so one is to be removed from another device before signing in again;
 * - mismatch: the browser came back for another sign-in;
 * - unreachable: the server could not be reached;
 * - failed: anything else.
 */
export const SIGN_IN_FAILURES = [
  "cancelled",
  "timed-out",
  "access_denied",
  "unverified_email",
  "not_invited",
  ...SIGNUP_FAILURES,
  "server_error",
  "invalid_grant",
  "too_many_devices",
  "mismatch",
  "unreachable",
  "failed",
] as const;
export const SignInFailureSchema = z.enum(SIGN_IN_FAILURES);
export type SignInFailure = z.infer<typeof SignInFailureSchema>;

/**
 * The failures that come of the server taking approved accounts only; they
 * say so in a line of their own (`remote.account.approvedOnly`).
 */
export const APPROVED_ONLY_FAILURES: readonly SignInFailure[] = [
  "pending_approval",
  "closed",
  "not_invited",
];

/**
 * How a failed sign-in is shown: waiting (on an approval, or the user's
 * own cancel), a step to take, or an account stopped.
 */
export type SignInFailureTone = "info" | "warning" | "error";

export function signInFailureTone(failure: SignInFailure): SignInFailureTone {
  if (failure === "pending_approval" || failure === "access_denied") return "info";
  if (failure === "suspended") return "error";
  return "warning";
}

/**
 * Where the account stands: signed out (with why the last sign-in failed,
 * if it did), signing in (the browser is open on the server's sign-in),
 * or signed in.
 */
export const RemoteAccountStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("signed-out"),
    server: z.string(),
    failure: SignInFailureSchema.optional(),
  }),
  z.object({ status: z.literal("signing-in"), server: z.string() }),
  z.object({
    status: z.literal("signed-in"),
    server: z.string(),
    user: RemoteUserSchema,
    device: RemoteDeviceInfoSchema,
  }),
]);
export type RemoteAccountState = z.infer<typeof RemoteAccountStateSchema>;

/**
 * The fewest characters an account password may have. Whoever gets the
 * locked bundle can guess offline; its length and Argon2id are what slow
 * them down.
 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * A reset of the account password asked for without it, which waits
 * (account keys v2): when it is put in place, and the device that asked
 * (`self` when it is this one).
 */
export const PendingResetInfoSchema = z.object({
  appliesAt: NumberSchema,
  deviceId: z.string(),
  self: z.boolean().optional(),
});
export type PendingResetInfo = z.infer<typeof PendingResetInfoSchema>;

/** What the server says beside where the key stands: a reset that waits. */
const KeyExtrasSchema = z.object({
  pendingReset: PendingResetInfoSchema.optional(),
});

/**
 * Where this device stands with the account key:
 * - checking: asking the server for the bundle;
 * - missing: the account has no key yet: the user sets the account password;
 * - locked: the account has one this device does not hold (or holds an
 *   older one, after a reset elsewhere): the user types the password, or
 *   pairs with a device that holds it;
 * - unlocked: this device holds the key, version `kid`;
 * - unavailable: the server could not be asked; `retryAt` (Unix ms) when it
 *   asked to wait.
 */
export const AccountKeyStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("signed-out") }),
  z.object({ status: z.literal("checking") }),
  z.object({ status: z.literal("missing") }),
  z.object({ status: z.literal("locked"), kid: PositiveIntegerSchema }).merge(KeyExtrasSchema),
  z.object({ status: z.literal("unlocked"), kid: PositiveIntegerSchema }).merge(KeyExtrasSchema),
  z.object({ status: z.literal("unavailable"), retryAt: NumberSchema.optional() }),
]);
export type AccountKeyState = z.infer<typeof AccountKeyStateSchema>;

/**
 * Why setting, typing, changing or resetting the account password failed:
 * - too-short: under MIN_PASSWORD_LENGTH;
 * - wrong-password: it did not open the bundle;
 * - conflict: another device changed the bundle meanwhile (the state says
 *   what it is now);
 * - unavailable: the server could not be asked, or asked to wait;
 * - signed-out: the sign-in ended;
 * - too-heavy: the bundle is locked with heavier settings than this app
 *   opens one with (MAX_OPEN_KDF): a newer app's, or a server's doing;
 * - weak-kdf: the server requires stronger settings for a new bundle;
 * - account-auth: the password opened the bundle, but the server did not
 *   take its proof (its verifier is another's: a reset sets it anew);
 * - device-key: a device's key does not check under the account key, so
 *   the key was not rotated (someone changed it on the server);
 * - reset-pending: a reset already waits;
 * - needs-password: the device that asked for a reset may hold the key, so
 *   it is removed with the password, which changes the key, or keeping it.
 */
export const KEY_FAILURES = [
  "too-short",
  "wrong-password",
  "conflict",
  "unavailable",
  "signed-out",
  "too-heavy",
  "weak-kdf",
  "account-auth",
  "device-key",
  "reset-pending",
  "needs-password",
] as const;
export type KeyFailure = (typeof KEY_FAILURES)[number];
