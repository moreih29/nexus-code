import { Square, X } from 'lucide-react'
import { useRef, useState, useEffect, type KeyboardEvent, type DragEvent } from 'react'
import { Button } from '@renderer/components/ui/button'
import type { ImageAttachment } from '../../../shared/types'
import { useSessionStore } from '../../stores/session-store'

const SUPPORTED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const MAX_SIZE_BYTES = 5 * 1024 * 1024 // 5MB

interface AttachmentPreview {
  file: File
  preview: string
  mediaType: string
  data: string
}

interface ChatInputProps {
  onSend: (text: string, images?: ImageAttachment[]) => void
  onStop?: () => void
  disabled?: boolean
  isRunning?: boolean
}

export function ChatInput({ onSend, onStop, disabled = false, isRunning = false }: ChatInputProps) {
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<AttachmentPreview[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [sizeError, setSizeError] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isComposingRef = useRef(false)
  const prefillText = useSessionStore((s) => s.activeTabId ? s.tabs[s.activeTabId]?.prefillText ?? '' : '')
  const setPrefillText = useSessionStore((s) => s.setPrefillText)

  // prefillText가 설정되면 입력창에 채우기
  useEffect(() => {
    if (prefillText) {
      setValue(prefillText)
      setPrefillText('')
      // 높이 자동 조정
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (el) {
          el.style.height = 'auto'
          el.style.height = `${Math.min(el.scrollHeight, 200)}px`
        }
      })
    }
  }, [prefillText, setPrefillText])

  const submit = (): void => {
    const trimmed = value.trim()
    if ((!trimmed && attachments.length === 0) || disabled) return
    const images = attachments.length > 0
      ? attachments.map((a) => ({ mediaType: a.mediaType, data: a.data }))
      : undefined
    onSend(trimmed, images)
    setValue('')
    setAttachments([])
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

  const processFiles = (files: FileList | File[]): void => {
    const fileArray = Array.from(files)
    setSizeError('')
    for (const file of fileArray) {
      if (!SUPPORTED_TYPES.includes(file.type)) continue
      if (file.size > MAX_SIZE_BYTES) {
        setSizeError(`${file.name} 파일이 5MB를 초과합니다.`)
        continue
      }
      const reader = new FileReader()
      reader.onload = (e) => {
        const result = e.target?.result as string
        // data URL 형식: "data:image/png;base64,XXXX"
        const base64Data = result.split(',')[1]
        if (!base64Data) return
        setAttachments((prev) => [
          ...prev,
          {
            file,
            preview: result,
            mediaType: file.type,
            data: base64Data,
          },
        ])
      }
      reader.readAsDataURL(file)
    }
  }

  const handleDragOver = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    const { files } = e.dataTransfer
    if (files.length > 0) {
      processFiles(files)
    }
  }

  const removeAttachment = (index: number): void => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }

  return (
    <div
      className={`border-t border-border bg-background px-4 py-3 transition-colors ${isDragging ? 'border-blue-500 bg-blue-950/20' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 크기 초과 에러 */}
      {sizeError && (
        <div className="mb-2 flex items-center justify-between rounded-lg bg-red-950/40 px-3 py-1.5 text-xs text-red-400">
          <span>{sizeError}</span>
          <button type="button" onClick={() => setSizeError('')} className="ml-2 opacity-70 hover:opacity-100">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* 첨부 미리보기 */}
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((att, i) => (
            <div key={i} className="relative inline-flex items-center">
              <img
                src={att.preview}
                alt={att.file.name}
                className="h-16 w-16 rounded-lg object-cover border border-border"
              />
              <button
                type="button"
                onClick={() => removeAttachment(i)}
                className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-muted text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
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
          className="max-h-[200px] flex-1 resize-none rounded-xl bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
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
            disabled={disabled || (!value.trim() && attachments.length === 0)}
            type="button"
          >
            전송
          </Button>
        )}
      </div>
    </div>
  )
}
