import { useCallback, useSyncExternalStore } from "react";
import { createListenerBus } from "../../../../shared/util/listener-bus";

let parkEl: HTMLElement | null = null;
const bus = createListenerBus();

const viewPark: {
  set(el: HTMLElement | null): void;
  get(): HTMLElement | null;
  subscribe(listener: () => void): () => void;
} = {
  set(el) {
    if (parkEl === el) return;
    parkEl = el;
    bus.notify();
  },
  get() {
    return parkEl;
  },
  subscribe(listener) {
    return bus.subscribe(listener);
  },
};

const getServerSnapshot = (): HTMLElement | null => null;

export function useViewPark(): HTMLElement | null {
  return useSyncExternalStore(viewPark.subscribe, viewPark.get, getServerSnapshot);
}

export function ViewParkRoot(): React.JSX.Element {
  const ref = useCallback((el: HTMLDivElement | null) => {
    viewPark.set(el);
  }, []);
  return (
    <div
      ref={ref}
      aria-hidden
      inert
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: 0,
        height: 0,
        overflow: "hidden",
        visibility: "hidden",
        pointerEvents: "none",
        contain: "strict",
      }}
    />
  );
}
