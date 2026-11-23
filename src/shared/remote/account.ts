import { z } from "zod";
import {
  NumberSchema,
  PositiveIntegerSchema,
} from "../../../packages/remote-protocol/src/validation";

export const SIGN_IN_PROVIDERS = ["apple", "google", "github", "dev"] as const;
export const SignInProviderSchema = z.enum(SIGN_IN_PROVIDERS);
export type SignInProvider = z.infer<typeof SignInProviderSchema>;

export const RemoteUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
});
export type RemoteUser = z.infer<typeof RemoteUserSchema>;

export const RemoteDeviceInfoSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  alias: z.string().nullable().optional(),
  platform: z.string(),
  createdAt: NumberSchema.optional(),
  lastSeenAt: NumberSchema.optional(),
  current: z.boolean().optional(),
});
export type RemoteDeviceInfo = z.infer<typeof RemoteDeviceInfoSchema>;

export const MAX_DEVICE_ALIAS = 64;

export function deviceLabel(device: { name: string; alias?: string | null }): string {
  return device.alias || device.name;
}

export const SIGNUP_FAILURES = ["pending_approval", "rejected", "suspended", "closed"] as const;

export const SIGN_IN_FAILURES = [
  "cancelled",
  "timed-out",
  "access_denied",
  "unverified_email",
  "not_invited",
  ...SIGNUP_FAILURES,
  "server_error",
  "invalid_grant",
  "rate_limited",
  "too_many_devices",
  "mismatch",
  "unreachable",
  "failed",
] as const;
export const SignInFailureSchema = z.enum(SIGN_IN_FAILURES);
export type SignInFailure = z.infer<typeof SignInFailureSchema>;

const SIGN_IN_PROVIDER_NAMES: Partial<Record<SignInProvider, string>> = {
  apple: "Apple",
  google: "Google",
  github: "GitHub",
};

export function signInProviderName(provider: SignInProvider | undefined): string | undefined {
  return provider ? SIGN_IN_PROVIDER_NAMES[provider] : undefined;
}

export const APPROVED_ONLY_FAILURES: readonly SignInFailure[] = [
  "pending_approval",
  "closed",
  "not_invited",
];

export const SIGN_IN_HELP_FAILURES: readonly SignInFailure[] = [
  ...APPROVED_ONLY_FAILURES,
  "rejected",
];

export type SignInFailureTone = "info" | "warning" | "error";

export function signInFailureTone(failure: SignInFailure): SignInFailureTone {
  if (failure === "pending_approval" || failure === "access_denied") return "info";
  if (failure === "suspended") return "error";
  return "warning";
}

export const RemoteAccountStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("signed-out"),
    server: z.string(),
    failure: SignInFailureSchema.optional(),
    provider: SignInProviderSchema.optional(),
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

export const MIN_PASSWORD_LENGTH = 12;

export const PendingResetInfoSchema = z.object({
  appliesAt: NumberSchema,
  deviceId: z.string(),
  self: z.boolean().optional(),
});
export type PendingResetInfo = z.infer<typeof PendingResetInfoSchema>;

const KeyExtrasSchema = z.object({
  pendingReset: PendingResetInfoSchema.optional(),
});

export const AccountKeyStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("signed-out") }),
  z.object({ status: z.literal("checking") }),
  z.object({ status: z.literal("missing") }),
  z.object({ status: z.literal("locked"), kid: PositiveIntegerSchema }).merge(KeyExtrasSchema),
  z.object({ status: z.literal("unlocked"), kid: PositiveIntegerSchema }).merge(KeyExtrasSchema),
  z.object({ status: z.literal("unavailable"), retryAt: NumberSchema.optional() }),
]);
export type AccountKeyState = z.infer<typeof AccountKeyStateSchema>;

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
