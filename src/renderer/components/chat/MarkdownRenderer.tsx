import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from './CodeBlock'

interface MarkdownRendererProps {
  content: string
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        h1: ({ children }) => (
          <h1 className="mb-3 mt-4 text-xl font-bold text-foreground">{children}</h1>
        ),
        h2: ({ children }) => (
          <h2 className="mb-2 mt-3 text-lg font-semibold text-foreground">{children}</h2>
        ),
        h3: ({ children }) => (
          <h3 className="mb-2 mt-3 text-base font-semibold text-foreground">{children}</h3>
        ),
        code: ({ children, className }) => {
          const match = /language-(\w+)/.exec(className || '')
          if (match) {
            return (
              <CodeBlock
                language={match[1]}
                code={String(children).replace(/\n$/, '')}
              />
            )
          }
          return (
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm text-blue-300">
              {children}
            </code>
          )
        },
        pre: ({ children }) => <pre className="mb-0">{children}</pre>,
        ul: ({ children }) => (
          <ul className="mb-2 list-disc pl-5 text-foreground">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="mb-2 list-decimal pl-5 text-foreground">{children}</ol>
        ),
        li: ({ children }) => <li className="mb-1">{children}</li>,
        blockquote: ({ children }) => (
          <blockquote className="mb-2 border-l-2 border-border pl-3 text-muted-foreground">
            {children}
          </blockquote>
        ),
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="text-blue-400 underline hover:text-blue-300"
          >
            {children}
          </a>
        ),
        table: ({ children }) => (
          <div className="mb-3 overflow-x-auto">
            <table className="w-full border-collapse text-sm">{children}</table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border border-border bg-muted px-3 py-2 text-left font-semibold text-foreground">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border border-border px-3 py-2 text-foreground">{children}</td>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  )
}
