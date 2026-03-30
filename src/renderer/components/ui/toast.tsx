import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'

interface ToastData {
  id: number
  message: string
  action?: { label: string; onClick: () => void }
  duration: number
}

interface ToastStore {
  toasts: ToastData[]
  show: (message: string, action?: ToastData['action'], duration?: number) => void
  dismiss: (id: number) => void
}

let nextId = 0

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  show: (message, action, duration = 3000) => {
    const id = ++nextId
    set((s) => ({ toasts: [...s.toasts, { id, message, action, duration }] }))
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

export function useToast() {
  return useToastStore((s) => s.show)
}

function ToastItem({ toast }: { toast: ToastData }) {
  const dismiss = useToastStore((s) => s.dismiss)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    timerRef.current = setTimeout(() => dismiss(toast.id), toast.duration)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [toast.id, toast.duration, dismiss])

  const handleAction = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    toast.action?.onClick()
    dismiss(toast.id)
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 shadow-lg">
      <span className="text-sm text-foreground">{toast.message}</span>
      {toast.action && (
        <button
          onClick={handleAction}
          className="shrink-0 text-sm font-medium text-primary hover:text-primary/80"
        >
          {toast.action.label}
        </button>
      )}
    </div>
  )
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts)

  if (toasts.length === 0) return null

  return createPortal(
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>,
    document.body,
  )
}
