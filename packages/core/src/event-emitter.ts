export type Listener<T> = (event: T) => void;

export class TypedEventEmitter<
  TEventMap extends Record<string, unknown>,
> {
  private listeners = new Map<keyof TEventMap, Set<Listener<never>>>();

  on<K extends keyof TEventMap>(
    event: K,
    listener: Listener<TEventMap[K]>,
  ): () => void {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => {
      set.delete(listener as Listener<never>);
    };
  }

  emit<K extends keyof TEventMap>(event: K, data: TEventMap[K]): void {
    const set = this.listeners.get(event);
    if (set === undefined || set.size === 0) return;
    for (const listener of set) {
      try {
        (listener as Listener<TEventMap[K]>)(data);
      } catch {
        // Listener errors must not affect cache operations
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  hasListeners<K extends keyof TEventMap>(event: K): boolean {
    const set = this.listeners.get(event);
    return set !== undefined && set.size > 0;
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
