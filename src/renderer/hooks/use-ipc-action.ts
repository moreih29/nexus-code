import { useCallback, useEffect, useRef, useState } from "react";
import { isAbortError } from "../../shared/abort";
import { type AppError, appErrorBug, appErrorCancelled } from "../../shared/error/app-error";
import { ipcErrorToAppError, isIpcErrResult } from "../../shared/ipc/result";

export interface IpcActionStateIdle {
  readonly status: "idle";
}

export interface IpcActionStateLoading {
  readonly status: "loading";
}

export interface IpcActionStateSuccess<T> {
  readonly status: "success";
  readonly value: T;
}

export interface IpcActionStateError {
  readonly status: "error";
  readonly error: AppError;
}

export type IpcActionState<T> =
  | IpcActionStateIdle
  | IpcActionStateLoading
  | IpcActionStateSuccess<T>
  | IpcActionStateError;

export interface UseIpcActionOptions<T> {
  onSuccess?: (value: T) => void;
}

export interface UseIpcActionReturn<T> {
  readonly state: IpcActionState<T>;

  readonly run: (action: (signal: AbortSignal) => Promise<T>) => void;

  readonly cancel: () => void;

  readonly isPending: boolean;
}

export function useIpcAction<T>(options: UseIpcActionOptions<T> = {}): UseIpcActionReturn<T> {
  const { onSuccess } = options;

  const [state, setState] = useState<IpcActionState<T>>({ status: "idle" });

  const mountedRef = useRef(true);

  const controllerRef = useRef<AbortController | null>(null);

  const onSuccessRef = useRef(onSuccess);
  useEffect(() => {
    onSuccessRef.current = onSuccess;
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  const cancel = useCallback(() => {
    if (!controllerRef.current) return;
    controllerRef.current.abort();
    controllerRef.current = null;
    if (mountedRef.current) {
      setState({ status: "idle" });
    }
  }, []);

  const run = useCallback((action: (signal: AbortSignal) => Promise<T>) => {
    if (controllerRef.current) return;

    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ status: "loading" });

    (async () => {
      try {
        const value = await action(controller.signal);

        if (!mountedRef.current || controllerRef.current !== controller) return;

        setState({ status: "success", value });
        onSuccessRef.current?.(value);
      } catch (err: unknown) {
        if (!mountedRef.current || controllerRef.current !== controller) return;

        const isCancellation =
          isAbortError(err) || (isAppError(err) && err.category === "cancelled");

        if (isCancellation) {
          setState({ status: "idle" });
        } else {
          setState({ status: "error", error: normaliseError(err) });
        }
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
        }
      }
    })();
  }, []);

  return {
    state,
    run,
    cancel,
    isPending: state.status === "loading",
  };
}

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === "object" &&
    value !== null &&
    "category" in value &&
    typeof (value as Record<string, unknown>).category === "string" &&
    "message" in value &&
    typeof (value as Record<string, unknown>).message === "string"
  );
}

export function normaliseError(err: unknown): AppError {
  if (isIpcErrResult(err)) return ipcErrorToAppError(err);
  if (isAbortError(err)) return appErrorCancelled(err.message);
  if (isAppError(err)) return err;

  if (err instanceof Error) {
    return appErrorBug(err.message);
  }

  const message = typeof err === "string" ? err : "An unexpected error occurred";
  return appErrorBug(message);
}

export { appErrorCancelled };
