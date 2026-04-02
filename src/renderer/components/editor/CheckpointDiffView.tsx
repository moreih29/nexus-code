import { useState } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import type { CheckpointDiffFile } from '../../../shared/types'

interface CheckpointDiffViewProps {
  files: CheckpointDiffFile[]
}

const STATUS_STYLES: Record<CheckpointDiffFile['status'], string> = {
  added: 'text-green-400',
  modified: 'text-yellow-400',
  deleted: 'text-red-400',
}

const STATUS_LABELS: Record<CheckpointDiffFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
}

export function CheckpointDiffView({ files }: CheckpointDiffViewProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selected = files[selectedIndex]

  if (files.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        변경된 파일이 없습니다.
      </div>
    )
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* 좌측 파일 목록 */}
      <div className="w-56 shrink-0 border-r border-border overflow-y-auto bg-background">
        <div className="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider border-b border-border">
          변경 파일 ({files.length})
        </div>
        {files.map((file, i) => (
          <button
            key={file.path}
            onClick={() => setSelectedIndex(i)}
            className={[
              'w-full text-left px-3 py-1.5 text-xs font-mono flex items-center gap-1.5 hover:bg-muted/50 transition-colors',
              i === selectedIndex ? 'bg-muted/70' : '',
            ].join(' ')}
          >
            <span className={`shrink-0 font-bold ${STATUS_STYLES[file.status]}`}>
              {STATUS_LABELS[file.status]}
            </span>
            <span className="truncate text-foreground/80">{file.path}</span>
          </button>
        ))}
      </div>

      {/* 우측 diff 뷰 */}
      <div className="flex-1 overflow-hidden">
        {selected && (
          <DiffEditor
            height="100%"
            original={selected.oldContent}
            modified={selected.newContent}
            language={detectLanguage(selected.path)}
            theme="vs-dark"
            options={{
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 12,
              lineNumbers: 'on',
              wordWrap: 'off',
            }}
          />
        )}
      </div>
    </div>
  )
}

function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    md: 'markdown',
    css: 'css',
    html: 'html',
    py: 'python',
    go: 'go',
    rs: 'rust',
    sh: 'shell',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'ini',
  }
  return langMap[ext] ?? 'plaintext'
}
