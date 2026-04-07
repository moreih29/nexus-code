export interface EventPort {
  emit(event: string, data: unknown): void
  on(event: string, handler: (data: unknown) => void): () => void
}
