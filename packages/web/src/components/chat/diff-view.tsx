interface DiffViewProps {
  result: string
}

interface DiffLine {
  type: 'add' | 'remove' | 'context'
  content: string
}

function parseDiffLines(result: string): DiffLine[] {
  return result.split('\n').map((line) => {
    if (line.startsWith('+')) {
      return { type: 'add', content: line }
    }
    if (line.startsWith('-')) {
      return { type: 'remove', content: line }
    }
    return { type: 'context', content: line }
  })
}

export function DiffView({ result }: DiffViewProps) {
  const lines = parseDiffLines(result)

  return (
    <div className="font-mono text-[11px] leading-[1.7] overflow-x-auto">
      {lines.map((line, idx) => {
        let className = 'px-2 whitespace-pre block'
        if (line.type === 'add') {
          className += ' text-green bg-green/10'
        } else if (line.type === 'remove') {
          className += ' text-red bg-red/10'
        } else {
          className += ' text-text-muted'
        }
        return (
          <span key={idx} className={className}>
            {line.content || ' '}
          </span>
        )
      })}
    </div>
  )
}
