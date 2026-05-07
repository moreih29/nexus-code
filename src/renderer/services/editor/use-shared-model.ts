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
import {
  acquireModel,
  getModelSnapshot,
  isMonacoReady,
  onMonacoReady,
  releaseModel,
  type SharedModelState,
  subscribeModel,
  toFileErrorCode,
} from "./model-cache";
import type { EditorInput } from "./types";

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
    const sharedInput = { workspaceId, filePath };

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
          if (snap) setState(snap);
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
  }, [workspaceId, filePath, monacoReady]);

  return state;
}
