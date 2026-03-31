import type { ModelId } from '../stores/settings-store'

export const MODEL_ALIASES: Record<ModelId, string> = {
  'claude-opus-4-6': 'Opus 4.6',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-haiku-4-5': 'Haiku 4.5',
}

export function getModelAlias(modelId: string): string {
  return MODEL_ALIASES[modelId as ModelId] ?? modelId
}
