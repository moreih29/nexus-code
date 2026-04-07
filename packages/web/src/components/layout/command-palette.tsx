import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

export interface Command {
  id: string
  label: string
  description?: string
  shortcut?: string
  action: () => void
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  commands: Command[]
}

export function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const filtered = query.trim()
    ? commands.filter(
        (cmd) =>
          cmd.label.toLowerCase().includes(query.toLowerCase()) ||
          cmd.description?.toLowerCase().includes(query.toLowerCase()),
      )
    : commands

  // Reset state when opened
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  // Reset active index when filter changes
  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  // Scroll active item into view
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const item = list.children[activeIndex] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (i + 1) % Math.max(1, filtered.length))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (i - 1 + Math.max(1, filtered.length)) % Math.max(1, filtered.length))
      return
    }
    if (e.key === 'Enter') {
      const cmd = filtered[activeIndex]
      if (cmd) {
        cmd.action()
        onClose()
      }
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      style={{ background: 'rgba(0,0,0,0.5)' }}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-[var(--border)] shadow-2xl overflow-hidden"
        style={{ background: 'var(--bg-surface)' }}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)]">
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            className="text-[var(--text-muted)] flex-shrink-0"
          >
            <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.3" />
            <path d="M9.5 9.5L12.5 12.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
            placeholder="커맨드 검색..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="text-[10px] text-[var(--text-muted)] border border-[var(--border)] rounded px-1 py-0.5 font-mono">
            ESC
          </kbd>
        </div>

        {/* Command list */}
        <ul ref={listRef} className="max-h-72 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <li className="px-4 py-3 text-sm text-[var(--text-muted)] text-center">
              결과 없음
            </li>
          ) : (
            filtered.map((cmd, i) => (
              <li key={cmd.id}>
                <button
                  className={cn(
                    'w-full flex items-center justify-between px-4 py-2.5 text-left transition-colors',
                    i === activeIndex
                      ? 'bg-[var(--accent)]/10 text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                  )}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => {
                    cmd.action()
                    onClose()
                  }}
                >
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{cmd.label}</span>
                    {cmd.description && (
                      <span className="text-xs text-[var(--text-muted)]">{cmd.description}</span>
                    )}
                  </span>
                  {cmd.shortcut && (
                    <kbd className="text-[10px] text-[var(--text-muted)] border border-[var(--border)] rounded px-1.5 py-0.5 font-mono flex-shrink-0 ml-4">
                      {cmd.shortcut}
                    </kbd>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  )
}
