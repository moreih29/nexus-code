import { useState } from 'react'
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Copy, Check, ExternalLink } from 'lucide-react'
import { useEditorStore } from '../../stores/editor-store'

import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import html from 'react-syntax-highlighter/dist/esm/languages/prism/markup'
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown'
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff'
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql'

SyntaxHighlighter.registerLanguage('tsx', tsx)
SyntaxHighlighter.registerLanguage('typescript', typescript)
SyntaxHighlighter.registerLanguage('ts', typescript)
SyntaxHighlighter.registerLanguage('javascript', javascript)
SyntaxHighlighter.registerLanguage('js', javascript)
SyntaxHighlighter.registerLanguage('jsx', jsx)
SyntaxHighlighter.registerLanguage('python', python)
SyntaxHighlighter.registerLanguage('py', python)
SyntaxHighlighter.registerLanguage('bash', bash)
SyntaxHighlighter.registerLanguage('sh', bash)
SyntaxHighlighter.registerLanguage('shell', bash)
SyntaxHighlighter.registerLanguage('json', json)
SyntaxHighlighter.registerLanguage('css', css)
SyntaxHighlighter.registerLanguage('html', html)
SyntaxHighlighter.registerLanguage('xml', html)
SyntaxHighlighter.registerLanguage('yaml', yaml)
SyntaxHighlighter.registerLanguage('yml', yaml)
SyntaxHighlighter.registerLanguage('markdown', markdown)
SyntaxHighlighter.registerLanguage('md', markdown)
SyntaxHighlighter.registerLanguage('diff', diff)
SyntaxHighlighter.registerLanguage('sql', sql)

let _snippetCounter = 0

interface CodeBlockProps {
  language: string
  code: string
  /** Edit/Write 도구 결과인 경우 파일 경로 */
  filePath?: string
}

export function CodeBlock({ language, code, filePath }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const requestOpenFile = useEditorStore((s) => s.requestOpenFile)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleOpenInEditor = () => {
    if (filePath) {
      requestOpenFile({ filePath })
    } else {
      _snippetCounter++
      const ext = language === 'typescript' || language === 'ts' ? 'ts'
        : language === 'javascript' || language === 'js' ? 'js'
        : language === 'python' || language === 'py' ? 'py'
        : language || 'txt'
      requestOpenFile({
        filePath: `snippet-${_snippetCounter}.${ext}`,
        content: code,
        language: language || 'plaintext',
        isTemporary: true,
      })
    }
  }

  return (
    <div className="relative mb-3 overflow-hidden rounded-lg last:mb-0">
      <div className="flex items-center justify-between bg-card px-4 py-1.5">
        <span className="text-xs font-medium text-muted-foreground">{language}</span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleOpenInEditor}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="에디터에서 열기"
          >
            <ExternalLink size={12} />
            <span>에디터</span>
          </button>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="코드 복사"
          >
            {copied ? (
              <>
                <Check size={12} />
                <span>복사됨!</span>
              </>
            ) : (
              <>
                <Copy size={12} />
                <span>복사</span>
              </>
            )}
          </button>
        </div>
      </div>
      <SyntaxHighlighter
        language={language}
        style={oneDark}
        customStyle={{
          margin: 0,
          borderRadius: 0,
          fontSize: '0.875rem',
        }}
        PreTag="div"
      >
        {code}
      </SyntaxHighlighter>
    </div>
  )
}
