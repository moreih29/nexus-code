import { useState, useEffect } from 'react'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'
import { IpcChannel } from '../../../shared/ipc'
import { useWorkspaceStore } from '../../stores/workspace-store'

export function MarkdownViewer() {
  const [filePath, setFilePath] = useState('')
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)

  const loadFile = async (p: string): Promise<void> => {
    if (!p.trim()) return
    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.invoke(
        IpcChannel.READ_FILE,
        { path: p.trim(), workspacePath: activeWorkspace ?? '' },
      )
      if (result.ok && result.content !== undefined) {
        setContent(result.content)
      } else {
        setError(result.error ?? '파일을 읽을 수 없습니다')
        setContent(null)
      }
    } catch (e) {
      setError(String(e))
      setContent(null)
    } finally {
      setLoading(false)
    }
  }

  // 경로 변경 후 엔터 또는 포커스 아웃 시 로드
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') loadFile(filePath)
  }

  const handleBlur = (): void => {
    loadFile(filePath)
  }

  // filePath 초기화 시 content도 초기화
  useEffect(() => {
    if (!filePath) {
      setContent(null)
      setError(null)
    }
  }, [filePath])

  return (
    <div className="flex h-full flex-col">
      {/* 파일 경로 입력 */}
      <div className="shrink-0 border-b border-border p-2">
        <input
          type="text"
          value={filePath}
          onChange={(e) => setFilePath(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          placeholder="파일 경로 입력 후 Enter..."
          className="w-full rounded bg-muted px-2 py-1 text-xs text-foreground placeholder-dim-foreground outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      {/* 콘텐츠 영역 */}
      <div className="flex-1 overflow-y-auto p-3 text-sm text-foreground">
        {loading && <p className="text-xs text-muted-foreground">불러오는 중...</p>}
        {error && <p className="text-xs text-red-400">{error}</p>}
        {content !== null && !loading && (
          <MarkdownRenderer content={content} />
        )}
        {content === null && !loading && !error && (
          <p className="text-xs text-dim-foreground">마크다운 파일 경로를 입력하세요</p>
        )}
      </div>
    </div>
  )
}
