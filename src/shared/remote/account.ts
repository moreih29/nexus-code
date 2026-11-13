/**
 * The app's NexusCode account, for the remote: who it is signed in as, on
 * which server, and this device as the server knows it.
 */
import { z } from "zod";

export const RemoteUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
});
export type RemoteUser = z.infer<typeof RemoteUserSchema>;

/** A device of the account, as the server knows it. */
export const RemoteDeviceInfoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    platform: z.string(),
    /** When the device signed in, and when the server last heard from it, in Unix ms. */
    createdAt: z.number().optional(),
    lastSeenAt: z.number().optional(),
    /** Whether it is the device asking. */
    current: z.boolean().optional(),
  })
  .passthrough();
export type RemoteDeviceInfo = z.infer<typeof RemoteDeviceInfoSchema>;

/**
 * Why a sign-in did not finish:
 * - cancelled, timed-out: the app stopped waiting for the browser;
 * - access_denied, unverified_email, server_error: what the server sent the
 *   browser back with (the user said no at Google; Google has not verified
 *   the email; the server failed);
 * - invalid_grant: the server would not trade the code (expired, or used);
 * - mismatch: the browser came back for another sign-in;
 * - unreachable: the server could not be reached;
 * - failed: anything else.
 */
export const SIGN_IN_FAILURES = [
  "cancelled",
  "timed-out",
  "access_denied",
  "unverified_email",
  "server_error",
  "invalid_grant",
  "mismatch",
  "unreachable",
  "failed",
] as const;
export const SignInFailureSchema = z.enum(SIGN_IN_FAILURES);
export type SignInFailure = z.infer<typeof SignInFailureSchema>;

/**
 * Where the account stands: signed out (with why the last sign-in failed,
 * if it did), signing in (the browser is open on the server's Google
 * sign-in), or signed in.
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
