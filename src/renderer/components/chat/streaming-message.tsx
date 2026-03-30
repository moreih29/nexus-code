import { MarkdownRenderer } from './MarkdownRenderer'

interface StreamingMessageProps {
  content: string
  isStreaming: boolean
}

export function StreamingMessage({ content, isStreaming }: StreamingMessageProps) {
  if (!isStreaming) {
    return <MarkdownRenderer content={content} />
  }

  return <MarkdownRenderer content={content + ' ▍'} />
}
