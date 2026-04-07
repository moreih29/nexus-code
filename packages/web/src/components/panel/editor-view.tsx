import { usePanelStore } from '../../stores/panel-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useWorkspaces, useFileContent } from '../../hooks/use-workspaces'

export function EditorView() {
  const { openFilePath, setRightTab } = usePanelStore()
  const { activeWorkspaceId } = useWorkspaceStore()
  const { data: workspaces } = useWorkspaces()

  const activeWorkspace = workspaces?.find((ws) => ws.id === activeWorkspaceId)
  const workspacePath = activeWorkspace?.path ?? null

  const { data, isLoading, isError, error } = useFileContent(workspacePath, openFilePath)

  const fileName = openFilePath ?? ''
  const parts = fileName.replace(/^\//, '').split('/')
  const displayName = parts[parts.length - 1] ?? ''

  function handleBack() {
    setRightTab('files')
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Header with back button and file name */}
      <div className="flex items-center bg-bg-elevated border-b border-border h-8 overflow-x-auto flex-shrink-0 gap-1 px-1">
        <button
          className="flex items-center gap-1 px-2 h-6 text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded transition-colors flex-shrink-0"
          onClick={handleBack}
          title="파일 목록으로 돌아가기"
        >
          ← 목록
        </button>
        <div className="flex items-center gap-1.5 px-2 text-[11px] text-text-primary bg-bg-surface border border-border-light rounded h-6 cursor-default whitespace-nowrap overflow-hidden">
          <span className="w-1.5 h-1.5 rounded-full bg-[#58a6ff] flex-shrink-0" />
          <span className="truncate">{displayName}</span>
        </div>
      </div>

      {/* Breadcrumb */}
      {openFilePath && (
        <div className="flex items-center gap-1 px-3 py-1 text-[11px] text-text-muted border-b border-border-light flex-shrink-0 overflow-x-auto whitespace-nowrap">
          {parts.map((part, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <span className="text-text-muted">/</span>}
              <span className={i === parts.length - 1 ? 'text-text-primary' : 'text-text-secondary'}>
                {part}
              </span>
            </span>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto font-mono text-[12px] leading-[1.6]">
        {isLoading && (
          <div className="px-4 py-3 text-text-secondary">불러오는 중...</div>
        )}
        {isError && (
          <div className="px-4 py-3 text-[#f85149]">
            파일을 불러올 수 없습니다: {error instanceof Error ? error.message : '알 수 없는 오류'}
          </div>
        )}
        {data && 'binary' in data && (
          <div className="px-4 py-3 text-text-secondary">
            바이너리 파일입니다 ({(data.size / 1024).toFixed(1)} KB)
          </div>
        )}
        {data && 'content' in data && (
          <FileContent content={data.content} />
        )}
        {!openFilePath && (
          <div className="px-4 py-3 text-text-secondary">파일을 선택하세요.</div>
        )}
      </div>
    </div>
  )
}

function FileContent({ content }: { content: string }) {
  const lines = content.split('\n')
  return (
    <>
      {lines.map((line, i) => (
        <div
          key={i}
          className="flex pr-4 min-h-[19px] hover:bg-bg-hover"
        >
          <span
            className="w-12 text-right pr-4 text-text-muted select-none flex-shrink-0"
            style={{ userSelect: 'none' }}
          >
            {i + 1}
          </span>
          <span className="flex-1 whitespace-pre text-[#e6edf3]">{line}</span>
        </div>
      ))}
    </>
  )
}
