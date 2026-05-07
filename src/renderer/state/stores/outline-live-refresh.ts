// Active-URI tracking for outline live-refresh.
//
// Owns three subscriptions for the currently active editor URI:
//   1. subscribeAllDirtyTransitions: debounced reload on dirty-state change (edit)
//   2. subscribeAllSaved: immediate force-reload on save
//   3. subscribeOnRelease: cancel pending debounce when the model is released
//
// Driven by outline-section.tsx via setActiveOutlineUri.
// All subscriptions for the previous URI are torn down on every URI change.

import { defaultTimerScheduler, type TimerScheduler } from "../../../shared/timer-scheduler";
import {
  type DirtyTransitionListener,
  subscribeAllDirtyTransitions,
  subscribeAllSaved,
} from "../../services/editor/dirty-tracker";
import type { SubscribeOnModelRelease } from "./outline";
import { useOutlineStore } from "./outline";

export const OUTLINE_REFRESH_DEBOUNCE_MS = 400;

type OutlineLoad = (
  uri: string,
  signal?: AbortSignal,
  options?: { force?: boolean },
) => Promise<void>;

function scheduleDebouncedOutlineLoad(options: {
  uri: string;
  load: (uri: string, signal?: AbortSignal) => Promise<void>;
  delayMs: number;
  scheduler: TimerScheduler;
}): () => void {
  const { uri, load, delayMs, scheduler } = options;
  const controller = new AbortController();
  const handle = scheduler.setTimeout(() => {
    load(uri, controller.signal).catch(() => {});
  }, delayMs);

  return () => {
    scheduler.clearTimeout(handle);
    controller.abort();
  };
}

// Injectable subscribers for testing.
type SubscribeDirtyTransitionsFn = (listener: DirtyTransitionListener) => () => void;
type SubscribeAllSavedFn = (listener: (e: { cacheUri: string }) => void) => () => void;
type SubscribeOnReleaseFn = SubscribeOnModelRelease;

let _subscribeDirtyTransitions: SubscribeDirtyTransitionsFn = subscribeAllDirtyTransitions;
let _subscribeAllSaved: SubscribeAllSavedFn = subscribeAllSaved;
let _subscribeOnRelease: SubscribeOnReleaseFn | null = null;
let _scheduler: TimerScheduler = defaultTimerScheduler;
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

  const disposeTransitions = _subscribeDirtyTransitions((event) => {
    if (event.cacheUri !== uri) return;
    if (cancelPending) cancelPending();
    const load = _getLoad();
    cancelPending = scheduleDebouncedOutlineLoad({
      uri,
      load: (u, s) => load(u, s, { force: true }),
      delayMs: OUTLINE_REFRESH_DEBOUNCE_MS,
      scheduler: _scheduler,
    });
  });

  const disposeSaved = _subscribeAllSaved((event) => {
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
  subscribeDirtyTransitions?: SubscribeDirtyTransitionsFn;
  subscribeAllSaved?: SubscribeAllSavedFn;
  subscribeOnRelease?: SubscribeOnReleaseFn;
  scheduler?: TimerScheduler;
  getLoad?: () => OutlineLoad;
}): void {
  if (overrides.subscribeDirtyTransitions !== undefined)
    _subscribeDirtyTransitions = overrides.subscribeDirtyTransitions;
  if (overrides.subscribeAllSaved !== undefined) _subscribeAllSaved = overrides.subscribeAllSaved;
  if (overrides.subscribeOnRelease !== undefined)
    _subscribeOnRelease = overrides.subscribeOnRelease;
  if (overrides.scheduler !== undefined) _scheduler = overrides.scheduler;
  if (overrides.getLoad !== undefined) _getLoad = overrides.getLoad;
}

export function __resetOutlineRefreshSubscribersForTests(): void {
  teardown();
  _subscribeDirtyTransitions = subscribeAllDirtyTransitions;
  _subscribeAllSaved = subscribeAllSaved;
  _subscribeOnRelease = null;
  _scheduler = defaultTimerScheduler;
  _getLoad = () => useOutlineStore.getState().load;
}
