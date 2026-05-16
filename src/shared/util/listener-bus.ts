export interface ListenerBus<T = void> {
  subscribe(listener: (value: T) => void): () => void;
  notify(value: T): void;
  clear(): void;
  readonly size: number;
}

export interface KeyedListenerBus<K, T = void> {
  subscribe(key: K, listener: (value: T) => void): () => void;
  notify(key: K, value: T): void;
  clearKey(key: K): void;
  clear(): void;
  sizeFor(key: K): number;
  readonly keyCount: number;
}

export function createListenerBus<T = void>(): ListenerBus<T> {
  const listeners = new Set<(value: T) => void>();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify(value) {
      for (const fn of Array.from(listeners)) {
        fn(value);
      }
    },
    clear() {
      listeners.clear();
    },
    get size() {
      return listeners.size;
    },
  };
}

export function createKeyedListenerBus<K, T = void>(): KeyedListenerBus<K, T> {
  const map = new Map<K, Set<(value: T) => void>>();

  return {
    subscribe(key, listener) {
      let set = map.get(key);
      if (!set) {
        set = new Set();
        map.set(key, set);
      }
      set.add(listener);
      return () => {
        const s = map.get(key);
        if (!s) return;
        s.delete(listener);
        if (s.size === 0) map.delete(key);
      };
    },
    notify(key, value) {
      const set = map.get(key);
      if (!set) return;
      for (const fn of Array.from(set)) {
        fn(value);
      }
    },
    clearKey(key) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
    sizeFor(key) {
      return map.get(key)?.size ?? 0;
    },
    get keyCount() {
      return map.size;
    },
  };
}
