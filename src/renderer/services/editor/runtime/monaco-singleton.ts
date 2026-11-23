import type * as Monaco from "monaco-editor";
import { createListenerBus } from "../../../../shared/util/listener-bus";

let monacoRef: typeof Monaco | null = null;
const bus = createListenerBus();

export function initializeMonacoSingleton(monaco: typeof Monaco): void {
  if (monacoRef === monaco) return;
  monacoRef = monaco;
  bus.notify();
}

export function requireMonaco(): typeof Monaco {
  if (!monacoRef) {
    throw new Error("Monaco is not initialized. Call initializeEditorServices(monaco) first.");
  }
  return monacoRef;
}

export function isMonacoReady(): boolean {
  return monacoRef !== null;
}

export function onMonacoReady(listener: () => void): () => void {
  return bus.subscribe(listener);
}
