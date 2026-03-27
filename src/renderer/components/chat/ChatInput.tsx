import { Square } from 'lucide-react'
import { useRef, useState, type KeyboardEvent } from 'react'
import { Button } from '@renderer/components/ui/button'

interface ChatInputProps {
  onSend: (text: string) => void
  onStop?: () => void
  disabled?: boolean
  isRunning?: boolean
}

export function ChatInput({ onSend, onStop, disabled = false, isRunning = false }: ChatInputProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isComposingRef = useRef(false)

  const submit = (): void => {
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setValue('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !isComposingRef.current) {
      e.preventDefault()
      submit()
    }
  }

  const handleInput = (): void => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  return (
    <div className="flex items-end gap-2 border-t border-gray-800 bg-gray-950 px-4 py-3">
      <textarea
        ref={textareaRef}
        rows={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => { isComposingRef.current = true }}
        onCompositionEnd={() => { isComposingRef.current = false }}
        onInput={handleInput}
        disabled={disabled && !isRunning}
        placeholder="메시지 입력 (Enter 전송 / Shift+Enter 줄바꿈)"
        className="max-h-[200px] flex-1 resize-none rounded-xl bg-gray-800 px-4 py-2.5 text-sm text-gray-100 placeholder-gray-500 outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
      />
      {isRunning ? (
        <Button
          size="sm"
          variant="destructive"
          className="shrink-0"
          onClick={onStop}
          type="button"
        >
          <Square className="h-4 w-4" />
          중지
        </Button>
      ) : (
        <Button
          size="sm"
          className="shrink-0"
          onClick={submit}
          disabled={disabled || !value.trim()}
          type="button"
        >
          전송
        </Button>
      )}
    </div>
  )
}
