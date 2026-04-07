import { usePanelStore } from '../../stores/panel-store'

interface EditorToken {
  type: 'kw' | 'str' | 'fn' | 'ty' | 'op' | 'num' | 'plain'
  text: string
}

interface EditorCodeLine {
  ln: number
  tokens: EditorToken[]
  highlight?: boolean
}

function tok(type: EditorToken['type'], text: string): EditorToken {
  return { type, text }
}

const codeLines: EditorCodeLine[] = [
  { ln: 1, tokens: [tok('kw', 'import'), tok('plain', ' { '), tok('ty', 'FC'), tok('plain', ' } '), tok('kw', 'from'), tok('plain', ' '), tok('str', "'react'")] },
  { ln: 2, tokens: [tok('kw', 'import'), tok('plain', ' { '), tok('fn', 'GitBranchIcon'), tok('plain', ' } '), tok('kw', 'from'), tok('plain', ' '), tok('str', "'./icons'")] },
  { ln: 3, tokens: [tok('plain', '')] },
  { ln: 4, tokens: [tok('kw', 'interface'), tok('plain', ' '), tok('ty', 'WorkspaceCardProps'), tok('plain', ' {')] },
  { ln: 5, tokens: [tok('plain', '  name: '), tok('ty', 'string')] },
  { ln: 6, tokens: [tok('plain', '  path: '), tok('ty', 'string')] },
  { ln: 7, tokens: [tok('plain', '  gitBranch'), tok('op', '?'), tok('plain', ': '), tok('ty', 'string')] },
  { ln: 8, tokens: [tok('plain', '  agentCount: '), tok('ty', 'number')] },
  { ln: 9, tokens: [tok('plain', '  isActive: '), tok('ty', 'boolean')] },
  { ln: 10, tokens: [tok('plain', '}')] },
  { ln: 11, tokens: [tok('plain', '')] },
  { ln: 12, tokens: [tok('kw', 'export const'), tok('plain', ' '), tok('fn', 'WorkspaceCard'), tok('plain', ': '), tok('ty', 'FC'), tok('plain', '<'), tok('ty', 'WorkspaceCardProps'), tok('plain', '> = ({')] },
  { ln: 13, tokens: [tok('plain', '  name, path, gitBranch, agentCount, isActive')] },
  { ln: 14, tokens: [tok('plain', '}) '), tok('kw', '=>'), tok('plain', ' {')] },
  { ln: 15, tokens: [tok('plain', '  '), tok('kw', 'return'), tok('plain', ' (')] },
  { ln: 16, tokens: [tok('plain', '    <'), tok('ty', 'div'), tok('plain', ' className='), tok('str', '"ws-card"'), tok('plain', '>')] },
  { ln: 17, tokens: [tok('plain', '      <'), tok('ty', 'div'), tok('plain', ' className='), tok('str', '"ws-card-header"'), tok('plain', '>')] },
  { ln: 18, tokens: [tok('plain', '        <'), tok('ty', 'StatusDot'), tok('plain', ' active={isActive} />')] },
  { ln: 19, tokens: [tok('plain', '        <'), tok('ty', 'span'), tok('plain', '>{name}</'), tok('ty', 'span'), tok('plain', '>')] },
  { ln: 20, tokens: [tok('plain', '      </'), tok('ty', 'div'), tok('plain', '>')] },
  { ln: 21, tokens: [tok('plain', '      <'), tok('ty', 'div'), tok('plain', ' className='), tok('str', '"ws-card-meta"'), tok('plain', '>')] },
  { ln: 22, tokens: [tok('plain', '        <'), tok('ty', 'span'), tok('plain', ' className='), tok('str', '"ws-branch"'), tok('plain', '>')]  , highlight: true },
  { ln: 23, tokens: [tok('plain', '          <'), tok('fn', 'GitBranchIcon'), tok('plain', ' size={'), tok('num', '12'), tok('plain', '} />')] , highlight: true },
  { ln: 24, tokens: [tok('plain', '          {gitBranch '), tok('op', '??'), tok('plain', ' '), tok('str', "'main'"), tok('plain', '}')] , highlight: true },
  { ln: 25, tokens: [tok('plain', '        </'), tok('ty', 'span'), tok('plain', '>')]                                                              , highlight: true },
  { ln: 26, tokens: [tok('plain', '        <'), tok('ty', 'span'), tok('plain', ' className='), tok('str', '"ws-path"'), tok('plain', '>{path}</'), tok('ty', 'span'), tok('plain', '>')] },
  { ln: 27, tokens: [tok('plain', '      </'), tok('ty', 'div'), tok('plain', '>')] },
  { ln: 28, tokens: [tok('plain', '    </'), tok('ty', 'div'), tok('plain', '>')] },
  { ln: 29, tokens: [tok('plain', '  )')] },
  { ln: 30, tokens: [tok('plain', '}')] },
]

const tokenColorMap: Record<EditorToken['type'], string> = {
  kw: '#bc8cff',
  str: '#a5d6ff',
  fn: '#d2a8ff',
  ty: '#79c0ff',
  op: '#f85149',
  num: '#79c0ff',
  plain: '#e6edf3',
}

function Token({ token }: { token: EditorToken }) {
  return (
    <span style={{ color: tokenColorMap[token.type] }}>{token.text}</span>
  )
}

export function EditorView() {
  const { openFilePath } = usePanelStore()

  const fileName = openFilePath ?? 'workspace-card.tsx'
  const parts = fileName.replace(/^\//, '').split('/')
  const displayName = parts[parts.length - 1]

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Editor tabs */}
      <div className="flex bg-bg-elevated border-b border-border h-8 overflow-x-auto flex-shrink-0">
        <div className="flex items-center gap-1.5 px-3 text-[11px] text-text-primary bg-bg-surface border-r border-border-light cursor-pointer whitespace-nowrap">
          <span className="w-1.5 h-1.5 rounded-full bg-[#d29922] flex-shrink-0" />
          {displayName}
        </div>
        <div className="flex items-center gap-1.5 px-3 text-[11px] text-text-secondary border-r border-border-light cursor-pointer whitespace-nowrap hover:text-text-primary">
          use-workspaces.ts
        </div>
      </div>

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 px-3 py-1 text-[11px] text-text-muted border-b border-border-light flex-shrink-0">
        <span className="text-text-secondary">src</span>
        <span>/</span>
        <span className="text-text-secondary">components</span>
        <span>/</span>
        <span className="text-text-primary">{displayName}</span>
      </div>

      {/* Code content */}
      <div className="flex-1 overflow-auto font-mono text-[12px] leading-[1.6]">
        {codeLines.map((line) => (
          <div
            key={line.ln}
            className="flex pr-4 min-h-[19px] hover:bg-bg-hover"
            style={line.highlight ? { background: 'rgba(88,166,255,0.08)' } : undefined}
          >
            <span
              className="w-12 text-right pr-4 text-text-muted select-none flex-shrink-0"
              style={{ userSelect: 'none' }}
            >
              {line.ln}
            </span>
            <span className="flex-1 whitespace-pre">
              {line.tokens.map((token, i) => (
                <Token key={i} token={token} />
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
