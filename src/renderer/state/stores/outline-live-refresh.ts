// Active-URI tracking for outline live-refresh.
//
// Owns three subscriptions for the currently active editor URI:
//   1. subscribeTransitions: debounced reload on dirty-state change (edit)
//   2. subscribeSaved: immediate force-reload on save
//   3. subscribeOnRelease: cancel pending debounce when the model is released
//
// Driven by outline-section.tsx via setActiveOutlineUri.
// All subscriptions for the previous URI are torn down on every URI change.

import { scheduleDebouncedOutlineLoad } from "../../components/lsp/outline/outline-section";
import {
  type DirtyTransitionListener,
  subscribeSaved,
  subscribeTransitions,
} from "../../services/editor/dirty-tracker";
import type { SubscribeOnModelRelease } from "./outline";
import { useOutlineStore } from "./outline";

export const OUTLINE_REFRESH_DEBOUNCE_MS = 400;

type OutlineLoad = (
  uri: string,
  signal?: AbortSignal,
  options?: { force?: boolean },
) => Promise<void>;
type OutlineTimerId = ReturnType<typeof setTimeout>;

// Injectable scheduler for testing the debounce timer.
export interface OutlineRefreshScheduler {
  setTimeout: (callback: () => void, delayMs: number) => OutlineTimerId;
  clearTimeout: (timerId: OutlineTimerId) => void;
}

// Injectable subscribers for testing.
type SubscribeTransitionsFn = (listener: DirtyTransitionListener) => () => void;
type SubscribeSavedFn = (listener: (e: { cacheUri: string }) => void) => () => void;
type SubscribeOnReleaseFn = SubscribeOnModelRelease;

let _subscribeTransitions: SubscribeTransitionsFn = subscribeTransitions;
let _subscribeSaved: SubscribeSavedFn = subscribeSaved;
let _subscribeOnRelease: SubscribeOnReleaseFn | null = null;
let _scheduler: OutlineRefreshScheduler = { setTimeout, clearTimeout };
let _getLoad: () => OutlineLoad = () => useOutlineStore.getState().load;

let _activeUri: string | null = null;
let _disposeAll: (() => void) | null = null;

function teardown(): void {
  _disposeAll?.();
  _disposeAll = null;
  _activeUri = null;
}

function setup(uri: string): void {
  let cancelPending: (() => void) | null = null;

  const disposeTransitions = _subscribeTransitions((event) => {
    if (event.cacheUri !== uri) return;
    if (cancelPending) cancelPending();
    const load = _getLoad();
    cancelPending = scheduleDebouncedOutlineLoad({
      uri,
      load: (u, s) => load(u, s, { force: true }),
      delayMs: OUTLINE_REFRESH_DEBOUNCE_MS,
      setTimeoutFn: _scheduler.setTimeout,
      clearTimeoutFn: _scheduler.clearTimeout,
    });
  });

  const disposeSaved = _subscribeSaved((event) => {
    if (event.cacheUri !== uri) return;
    if (cancelPending) {
      cancelPending();
      cancelPending = null;
    }
    _getLoad()(uri, undefined, { force: true }).catch(() => {});
  });

  const disposeRelease = _subscribeOnRelease
    ? _subscribeOnRelease((released) => {
        if (released.cacheUri !== uri) return;
        if (cancelPending) {
          cancelPending();
          cancelPending = null;
        }
      })
    : () => {};

  _disposeAll = () => {
    if (cancelPending) {
      cancelPending();
      cancelPending = null;
    }
    disposeTransitions();
    disposeSaved();
    disposeRelease();
  };
}

/**
 * Set the active outline URI. Tears down subscriptions for the previous
 * URI and installs new ones for the given URI. Pass null to tear down
 * without installing new subscriptions (e.g. when collapsed or no editor).
 */
export function setActiveOutlineUri(uri: string | null): void {
  if (_activeUri === uri) return;
  teardown();
  if (!uri) return;
  _activeUri = uri;
  setup(uri);
}

export function __setOutlineRefreshSubscribersForTests(overrides: {
  subscribeTransitions?: SubscribeTransitionsFn;
  subscribeSaved?: SubscribeSavedFn;
  subscribeOnRelease?: SubscribeOnReleaseFn;
  scheduler?: OutlineRefreshScheduler;
  getLoad?: () => OutlineLoad;
}): void {
  if (overrides.subscribeTransitions !== undefined)
    _subscribeTransitions = overrides.subscribeTransitions;
  if (overrides.subscribeSaved !== undefined) _subscribeSaved = overrides.subscribeSaved;
  if (overrides.subscribeOnRelease !== undefined)
    _subscribeOnRelease = overrides.subscribeOnRelease;
  if (overrides.scheduler !== undefined) _scheduler = overrides.scheduler;
  if (overrides.getLoad !== undefined) _getLoad = overrides.getLoad;
}

export function __resetOutlineRefreshSubscribersForTests(): void {
  teardown();
  _subscribeTransitions = subscribeTransitions;
  _subscribeSaved = subscribeSaved;
  _subscribeOnRelease = null;
  _scheduler = { setTimeout, clearTimeout };
  _getLoad = () => useOutlineStore.getState().load;
}
