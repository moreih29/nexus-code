import { useEffect, useRef, useState } from 'react'
import log from 'electron-log/renderer'
import { MarkdownRenderer } from './MarkdownRenderer'

interface StreamingMessageProps {
  content: string
  isStreaming: boolean
}

function charsPerFrame(gap: number, draining: boolean): number {
  if (draining) return Math.max(12, Math.ceil(gap / 8))
  if (gap <= 3) return 1
  if (gap <= 10) return 1
  if (gap <= 30) return 2
  if (gap <= 60) return 3
  return Math.min(5, Math.ceil(gap / 12))
}

export function StreamingMessage({ content, isStreaming }: StreamingMessageProps) {
  const [displayedLength, setDisplayedLength] = useState(0)
  const contentRef = useRef(content)
  const rafRef = useRef<number | null>(null)
  const drainingRef = useRef(false)

  contentRef.current = content

  useEffect(() => {
    if (!isStreaming) drainingRef.current = true
  }, [isStreaming])

  useEffect(() => {
    const tick = () => {
      setDisplayedLength((prev) => {
        const target = contentRef.current.length
        if (prev >= target) {
          rafRef.current = null
          return prev
        }
        const gap = target - prev
        const step = charsPerFrame(gap, drainingRef.current)
        const next = Math.min(prev + step, target)

        if (next < target) {
          rafRef.current = requestAnimationFrame(tick)
        } else {
          rafRef.current = null
          if (drainingRef.current) drainingRef.current = false
        }
        return next
      })
    }

    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(tick)
    }

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [content])

  log.debug('[DEBUG:stream] content=%d displayed=%d gap=%d streaming=%s draining=%s', content.length, displayedLength, content.length - displayedLength, isStreaming, drainingRef.current)

  if (!isStreaming && displayedLength >= content.length) {
    return <MarkdownRenderer content={content} />
  }

  const displayedContent = content.slice(0, displayedLength)

  return (
    <div className="streaming-content">
      <MarkdownRenderer content={displayedContent} />
      <span className="streaming-cursor" />
    </div>
  )
}
