// Servers ask the client for a `workspace/configuration` slice via
// dotted section names ("python.analysis.typeCheckingMode"). The host
// stores per-(workspace, language) initialization options and then
// resolves arbitrary dotted lookups against the flattened map. Lives
// in its own module so the host class only handles the storage policy.

export function flattenInitializationOptions(
  value: unknown,
  prefix = "",
  output = new Map<string, unknown>(),
): Map<string, unknown> {
  if (!isPlainConfigObject(value)) {
    if (prefix.length > 0) output.set(prefix, value);
    return output;
  }

  for (const [key, child] of Object.entries(value)) {
    const childKey = prefix.length > 0 ? `${prefix}.${key}` : key;
    if (isPlainConfigObject(child)) {
      flattenInitializationOptions(child, childKey, output);
    } else {
      output.set(childKey, child);
    }
  }
  return output;
}

export function lookupFlattenedConfig(flatConfig: Map<string, unknown>, section: string): unknown {
  if (flatConfig.has(section)) return flatConfig.get(section);

  const prefix = `${section}.`;
  const sectionValue: Record<string, unknown> = {};
  let found = false;
  for (const [key, value] of flatConfig) {
    if (!key.startsWith(prefix)) continue;
    found = true;
    setNestedConfigValue(sectionValue, key.slice(prefix.length).split("."), value);
  }
  return found ? sectionValue : null;
}

function isPlainConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setNestedConfigValue(
  target: Record<string, unknown>,
  pathParts: string[],
  value: unknown,
): void {
  let cursor = target;
  for (let index = 0; index < pathParts.length - 1; index += 1) {
    const part = pathParts[index];
    const existing = cursor[part];
    if (!isPlainConfigObject(existing)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  const leaf = pathParts.at(-1);
  if (leaf !== undefined) {
    cursor[leaf] = value;
  }
}
