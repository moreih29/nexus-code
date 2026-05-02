export function getDefaultShell(): string {
  const platform = process.platform;

  if (platform === "darwin") {
    return process.env.SHELL ?? "/bin/bash";
  }

  if (platform === "win32") {
    throw new Error(
      "getDefaultShell: not implemented in M0 — see deployment ADR"
    );
  }

  throw new Error(
    "getDefaultShell: not implemented in M0 — see deployment ADR"
  );
}
