export type CodexCollaborationMode = "plan" | "default";

export interface CodexCollaborationSettings {
  reasoning_effort: string | null;
  developer_instructions: string | null;
}

function record(raw: unknown): Record<string, unknown> | undefined {
  return raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
}

export function collaborationModeOf(value: unknown): CodexCollaborationMode | undefined {
  return value === "plan" || value === "default" ? value : undefined;
}

export function collaborationPresetsOf(raw: unknown) {
  const presets: Partial<Record<CodexCollaborationMode, { effort?: string }>> = {};
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const preset = record(entry);
      const mode = collaborationModeOf(preset?.mode);
      if (mode) {
        const effort = preset?.reasoning_effort;
        presets[mode] = typeof effort === "string" ? { effort } : {};
      }
    }
  }
  return presets;
}

export function collaborationSettingsOf(raw: unknown) {
  const value = record(raw);
  const mode = collaborationModeOf(value?.mode);
  const settings = record(value?.settings);
  if (!mode || !settings) return undefined;
  const { reasoning_effort, developer_instructions } = settings;
  return {
    mode,
    settings: {
      reasoning_effort: typeof reasoning_effort === "string" ? reasoning_effort : null,
      developer_instructions:
        typeof developer_instructions === "string" ? developer_instructions : null,
    },
  };
}
