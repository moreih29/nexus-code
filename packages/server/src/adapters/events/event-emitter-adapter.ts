import { EventEmitter } from 'node:events'
import type { EventPort } from '../../ports/event-port.js'

export class EventEmitterAdapter implements EventPort {
  private readonly _emitter = new EventEmitter()

  emit(event: string, data: unknown): void {
    this._emitter.emit(event, data)
  }

  on(event: string, handler: (data: unknown) => void): () => void {
    this._emitter.on(event, handler)
    return () => {
      this._emitter.off(event, handler)
    }
  }
}
