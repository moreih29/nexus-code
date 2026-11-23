interface SegmentPolicy {
  readonly emptySegments: "keep" | "discard";
  readonly leadingParents: "keep" | "discard";
}

export function reducePosixSegments(path: string, policy: SegmentPolicy): string[] {
  const segments: string[] = [];
  for (const part of path.split("/")) {
    if (part === "." || (part === "" && policy.emptySegments === "discard")) continue;
    if (part !== "..") {
      segments.push(part);
    } else if (
      policy.leadingParents === "keep" &&
      (segments.length === 0 || segments.at(-1) === "..")
    ) {
      segments.push(part);
    } else {
      segments.pop();
    }
  }
  return segments;
}
