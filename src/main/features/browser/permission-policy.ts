export type PermissionDecision = "allow" | "block" | "ask";

export interface PermissionResolverInput {
  readonly globalAllowed: boolean;
  readonly remembered: "allow" | "block" | null;
  readonly isKnownPermission: boolean;
}

export function resolvePermission(input: PermissionResolverInput): PermissionDecision {
  const { globalAllowed, remembered, isKnownPermission } = input;

  if (!isKnownPermission) {
    return "block";
  }

  if (globalAllowed) {
    return "allow";
  }

  if (remembered === "allow") {
    return "allow";
  }

  if (remembered === "block") {
    return "block";
  }

  return "ask";
}
