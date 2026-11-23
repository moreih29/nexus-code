import { TriangleAlert, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { DetailsDisclosure } from "@/components/ui/details-disclosure";
import { cn } from "@/utils/cn";
import { createListenerBus } from "../../../shared/util/listener-bus";
import {
  UI_TOAST_ERROR_MS,
  UI_TOAST_INFO_MS,
  UI_TOAST_SWEEP_INTERVAL_MS,
  UI_TOAST_WARNING_MS,
} from "../../../shared/util/timing-constants";

export type ToastKind = "info" | "error" | "warning";

export interface ToastAction {
  label: string;
  onAction: () => void;
  dedupeKey?: string;
}

export interface ToastInput {
  kind: ToastKind;
  message: string;
  durationMs?: number;
  actions?: ToastAction[];
  details?: string;
}

const TOAST_INFO_MS = UI_TOAST_INFO_MS;
const TOAST_ERROR_MS = UI_TOAST_ERROR_MS;
const TOAST_WARNING_MS = UI_TOAST_WARNING_MS;

const TOAST_SWEEP_INTERVAL_MS = UI_TOAST_SWEEP_INTERVAL_MS;

const NEVER_EXPIRES = Number.POSITIVE_INFINITY;

interface ActiveToast {
  id: number;
  kind: ToastKind;
  message: string;
  expiresAt: number;
  actionLabels: string[];
  details?: string;
}

let nextId = 1;
let active: ActiveToast[] = [];
const MAX_ACTIVE_TOASTS = 5;
const actionsByToast = new Map<number, ToastAction[]>();
const bus = createListenerBus();
const watchers = new Set<(toast: ToastInput) => void>();

export function watchToasts(watcher: (toast: ToastInput) => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

function defaultDuration(kind: ToastKind): number {
  if (kind === "error") return TOAST_ERROR_MS;
  if (kind === "warning") return TOAST_WARNING_MS;
  return TOAST_INFO_MS;
}

function sameActions(first: ToastAction[], second: ToastAction[]): boolean {
  return (
    first.length === second.length &&
    first.every((action, index) => {
      const candidate = second[index];
      if (candidate?.label !== action.label) return false;
      return action.dedupeKey !== undefined || candidate.dedupeKey !== undefined
        ? action.dedupeKey === candidate.dedupeKey
        : action.onAction === candidate.onAction;
    })
  );
}

export function showToast(input: ToastInput): number {
  for (const watcher of watchers) watcher(input);
  const actions = input.actions ?? [];

  const expiresAt =
    actions.length > 0 || input.details
      ? NEVER_EXPIRES
      : Date.now() + (input.durationMs ?? defaultDuration(input.kind));

  const duplicate = active.find(
    (toast) =>
      toast.kind === input.kind &&
      toast.message === input.message &&
      toast.details === input.details &&
      sameActions(actionsByToast.get(toast.id) ?? [], actions),
  );
  if (duplicate) {
    duplicate.expiresAt = expiresAt;
    return duplicate.id;
  }

  const id = nextId++;
  const oldest = active.at(0);
  if (active.length === MAX_ACTIVE_TOASTS && oldest) {
    actionsByToast.delete(oldest.id);
    active = active.slice(1);
  }
  if (actions.length > 0) actionsByToast.set(id, [...actions]);
  active = [
    ...active,
    {
      id,
      kind: input.kind,
      message: input.message,
      expiresAt,
      actionLabels: actions.map(({ label }) => label),
      details: input.details,
    },
  ];
  bus.notify();
  return id;
}

export function dismissToast(id: number): void {
  if (!active.some((toast) => toast.id === id)) return;
  actionsByToast.delete(id);
  active = active.filter((t) => t.id !== id);
  bus.notify();
}

export function runToastAction(id: number, index: number): void {
  const action = actionsByToast.get(id)?.[index];
  if (!action) return;
  dismissToast(id);
  action.onAction();
}

const STACK_BOTTOM_PX = 40;
const STACK_GAP_PX = 8;

function stackBottom(stack: HTMLElement): number {
  const { innerHeight } = window;
  const box = stack.getBoundingClientRect();
  const top = innerHeight - STACK_BOTTOM_PX - stack.offsetHeight;
  let bottom = STACK_BOTTOM_PX;
  for (const el of document.querySelectorAll<HTMLElement>("[data-toast-avoid]")) {
    if (
      typeof el.checkVisibility === "function" &&
      !el.checkVisibility({ visibilityProperty: true })
    )
      continue;
    const rect = el.getBoundingClientRect();
    const across = rect.left < box.right && rect.right > box.left;
    const under = rect.top < innerHeight - STACK_BOTTOM_PX && rect.bottom > top;
    if (across && under) bottom = Math.max(bottom, innerHeight - rect.top + STACK_GAP_PX);
  }
  return Math.min(bottom, innerHeight / 2);
}

export function ToastRoot(): React.JSX.Element | null {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState<ActiveToast[]>(active);
  const stackRef = useRef<HTMLDivElement>(null);
  const [bottom, setBottom] = useState(STACK_BOTTOM_PX);

  useEffect(() => {
    return bus.subscribe(() => setToasts([...active]));
  }, []);

  useEffect(() => {
    if (toasts.length === 0) return;
    const interval = setInterval(() => {
      const now = Date.now();
      const surviving = active.filter((t) => t.expiresAt > now);
      if (surviving.length !== active.length) {
        active = surviving;
        bus.notify();
      }
    }, TOAST_SWEEP_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [toasts.length]);

  useLayoutEffect(() => {
    if (toasts.length === 0) return;
    const place = () => {
      if (stackRef.current) setBottom(stackBottom(stackRef.current));
    };
    place();
    const interval = setInterval(place, TOAST_SWEEP_INTERVAL_MS);
    window.addEventListener("resize", place);
    return () => {
      clearInterval(interval);
      window.removeEventListener("resize", place);
    };
  }, [toasts]);

  if (toasts.length === 0) return null;

  return (
    <div
      data-toast-viewport=""
      ref={stackRef}
      className="fixed right-4 z-(--layer-toast) flex flex-col gap-2 w-[360px] max-w-[90vw]"
      style={{ bottom }}
    >
      {toasts.map((toast) => {
        const hasActions = toast.actionLabels.length > 0;
        const role: "alert" | "status" = hasActions ? "alert" : "status";
        const ariaLive: "assertive" | "polite" = hasActions ? "assertive" : "polite";

        return (
          <div
            key={toast.id}
            role={role}
            aria-live={ariaLive}
            className={cn(
              "flex flex-col gap-2 rounded-(--radius-raised) border px-3 py-2 shadow-none text-app-ui-sm",
              toast.kind === "error"
                ? "bg-destructive text-destructive-foreground border-destructive"
                : toast.kind === "warning"
                  ? "bg-[var(--state-warning-bg)] text-[var(--state-warning-fg)] border-[var(--state-warning-border)]"
                  : "bg-popover text-popover-foreground border-border",
            )}
          >
            <div className="flex items-start gap-2">
              {toast.kind === "warning" ? (
                <TriangleAlert className="size-4 shrink-0 mt-px" aria-hidden="true" />
              ) : null}
              <span className="flex-1 break-words">{toast.message}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-5 shrink-0 -mr-1 -mt-0.5 hover:bg-foreground/10"
                onClick={() => dismissToast(toast.id)}
                tooltip={t("action.dismiss")}
              >
                <X className="size-3.5" aria-hidden="true" />
              </Button>
            </div>

            {toast.details ? <DetailsDisclosure details={toast.details} /> : null}

            {hasActions ? (
              <div className="flex items-center gap-2 flex-wrap">
                {toast.actionLabels.map((label, index) => (
                  <Button
                    key={label}
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 hover:bg-foreground/10"
                    onClick={() => runToastAction(toast.id, index)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
