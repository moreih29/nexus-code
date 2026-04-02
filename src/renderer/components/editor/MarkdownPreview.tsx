import { useEffect, useState } from 'react'
import type * as monacoTypes from 'monaco-editor'
import { cn } from '../../lib/utils'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'

type PreviewMode = 'edit' | 'split' | 'preview'

interface MarkdownPreviewProps {
  model: monacoTypes.editor.ITextModel | null
  editorElement: React.ReactNode
}

export function MarkdownPreview({ model, editorElement }: MarkdownPreviewProps) {
  const [mode, setMode] = useState<PreviewMode>('split')
  const [content, setContent] = useState(() => model?.getValue() ?? '')

  // Monaco 모델 변경 구독 → 실시간 프리뷰 동기화
  useEffect(() => {
    if (!model) return
    setContent(model.getValue())
    const disposable = model.onDidChangeContent(() => {
      setContent(model.getValue())
    })
    return () => disposable.dispose()
  }, [model])

  return (
    <div className="flex h-full flex-col">
      {/* 콘텐츠 영역 */}
      <div className="flex min-h-0 flex-1">
        {/* Monaco 에디터 */}
        {(mode === 'edit' || mode === 'split') && (
          <div className={cn('min-h-0 overflow-hidden', mode === 'split' ? 'w-1/2' : 'w-full')}>
            {editorElement}
          </div>
        )}

        {/* 분할 구분선 */}
        {mode === 'split' && (
          <div className="w-px shrink-0 bg-border" />
        )}

        {/* 마크다운 프리뷰 */}
        {(mode === 'preview' || mode === 'split') && (
          <div className={cn(
            'min-h-0 overflow-y-auto p-4',
            mode === 'split' ? 'w-1/2' : 'w-full',
          )}>
            <MarkdownRenderer content={content} />
          </div>
        )}
      </div>

      {/* 모드 토글 바 */}
      <div className="flex h-7 shrink-0 items-center gap-1 border-t border-border px-2">
        <ModeButton label="편집만" active={mode === 'edit'} onClick={() => setMode('edit')} />
        <ModeButton label="분할" active={mode === 'split'} onClick={() => setMode('split')} />
        <ModeButton label="프리뷰만" active={mode === 'preview'} onClick={() => setMode('preview')} />
        <span className="ml-auto text-xs text-dim-foreground">Markdown</span>
      </div>
    </div>
  )
}

function ModeButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded px-2 py-0.5 text-xs transition-colors',
        active
          ? 'bg-primary/15 text-primary font-medium'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted',
      )}
    >
      {label}
    </button>
  )
}
