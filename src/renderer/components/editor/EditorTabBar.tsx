import { X } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { EditorFile } from '../../../shared/types'

interface EditorTabBarProps {
  files: EditorFile[]
  activeFilePath: string | null
  onSelect: (path: string) => void
  onClose: (path: string) => void
}

export function EditorTabBar({ files, activeFilePath, onSelect, onClose }: EditorTabBarProps) {
  if (files.length === 0) return null

  return (
    <div className="flex h-9 shrink-0 items-center overflow-x-auto border-b border-border bg-card">
      {files.map((file) => {
        const isActive = file.path === activeFilePath
        const fileName = file.path.split('/').pop() ?? file.path

        return (
          <div
            key={file.path}
            onClick={() => onSelect(file.path)}
            className={cn(
              'group flex h-full shrink-0 cursor-pointer items-center gap-1.5 border-b-2 px-3 text-xs transition-colors',
              isActive
                ? 'border-b-primary bg-primary/8 text-foreground'
                : 'border-b-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground',
            )}
          >
            {/* dirty 인디케이터 */}
            {file.isDirty && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" title="수정됨" />
            )}

            {/* 파일명 */}
            <span className={cn(
              'max-w-32 truncate',
              file.isTemporary && 'italic',
              isActive && 'font-medium',
            )}>
              {fileName}
            </span>

            {/* 임시 파일 표시 */}
            {file.isTemporary && (
              <span className="text-dim-foreground" title="임시 파일">◇</span>
            )}

            {/* 닫기 버튼 */}
            <button
              onClick={(e) => { e.stopPropagation(); onClose(file.path) }}
              className="hidden rounded p-0.5 hover:bg-muted group-hover:flex"
              title="닫기"
            >
              <X size={10} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
