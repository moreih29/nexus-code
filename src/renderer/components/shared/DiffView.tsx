interface DiffViewProps {
  oldString: string
  newString: string
  maxLines?: number
}

function truncateDiff(text: string, maxLines: number): { preview: string; truncated: boolean } {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return { preview: text, truncated: false }
  return { preview: lines.slice(0, maxLines).join('\n'), truncated: true }
}

export function DiffView({ oldString, newString, maxLines = 3 }: DiffViewProps) {
  const old_ = truncateDiff(oldString, maxLines)
  const new_ = truncateDiff(newString, maxLines)

  return (
    <div className="rounded border border-border overflow-hidden font-mono">
      <pre className="bg-red-950/40 px-2 py-1 text-red-300 whitespace-pre-wrap break-all">
        {old_.preview.split('\n').map((l, i) => (
          <span key={i} className="block">
            <span className="text-red-500 select-none">- </span>
            {l}
          </span>
        ))}
        {old_.truncated && <span className="text-muted-foreground">…</span>}
      </pre>
      <pre className="bg-green-950/40 px-2 py-1 text-green-300 whitespace-pre-wrap break-all">
        {new_.preview.split('\n').map((l, i) => (
          <span key={i} className="block">
            <span className="text-green-500 select-none">+ </span>
            {l}
          </span>
        ))}
        {new_.truncated && <span className="text-muted-foreground">…</span>}
      </pre>
    </div>
  )
}
