/**
 * React binding for the framework-agnostic model cache.
 *
 * Each `EditorView` mounts this hook with its EditorInput; the hook
 * acquires a ref-counted shared TextModel through {@link ./model-cache}
 * and hands back a `SharedModelState` snapshot, re-rendering on every
 * phase / model change.
 *
 * Lives in its own file so the cache module stays framework-agnostic
 * (it's also driven by save-service / promote-policy etc., which don't
 * involve React).
 */

import { useEffect, useState } from "react";
import type { EditorInput } from "../types";
import {
  acquireModel,
  getModelSnapshot,
  isMonacoReady,
  onMonacoReady,
  releaseModel,
  type SharedModelState,
  subscribeModel,
  toFileErrorCode,
} from "./cache";

function sameSnapshot(a: SharedModelState, b: SharedModelState): boolean {
  return (
    a.phase === b.phase &&
    a.model === b.model &&
    a.errorCode === b.errorCode &&
    a.readOnly === b.readOnly &&
    a.diskDiverged?.mtime === b.diskDiverged?.mtime &&
    a.diskDiverged?.size === b.diskDiverged?.size
  );
}

export function useSharedModel(input: EditorInput): SharedModelState {
  const { workspaceId, filePath } = input;
  const [state, setState] = useState<SharedModelState>({
    phase: "loading",
    model: null,
    readOnly: false,
  });
  const [monacoReady, setMonacoReady] = useState(isMonacoReady());

  useEffect(() => {
    if (isMonacoReady()) return;
    return onMonacoReady(() => setMonacoReady(true));
  }, []);

  useEffect(() => {
    let cancelled = false;
    let acquired = false;
    let unsubscribe = () => {};
    const sharedInput: EditorInput = { workspaceId, filePath, origin: input.origin };

    if (!monacoReady) {
      setState({ phase: "loading", model: null, readOnly: false });
      return () => {
        cancelled = true;
      };
    }

    setState({ phase: "loading", model: null, readOnly: false });

    acquireModel(sharedInput)
      .then((nextState) => {
        acquired = true;
        if (cancelled) {
          releaseModel(sharedInput);
          return;
        }

        setState(nextState);
        unsubscribe = subscribeModel(sharedInput, () => {
          const snap = getModelSnapshot(sharedInput);
          // Every reconcile notifies (one per fs/git event), usually with an
          // unchanged snapshot. Keeping the previous object skips re-rendering
          // the whole EditorView subtree — previews included — for nothing.
          if (snap) setState((prev) => (sameSnapshot(prev, snap) ? prev : snap));
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setState({
          phase: "error",
          model: null,
          errorCode: toFileErrorCode(error),
          readOnly: false,
        });
      });

    return () => {
      cancelled = true;
      unsubscribe();
      if (acquired) {
        releaseModel(sharedInput);
      }
    };
  }, [workspaceId, filePath, input.origin, monacoReady]);

  return state;
}
