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
          <h1 className="mb-3 mt-4 text-xl font-bold text-gray-100">{children}</h1>
        ),
        h2: ({ children }) => (
          <h2 className="mb-2 mt-3 text-lg font-semibold text-gray-200">{children}</h2>
        ),
        h3: ({ children }) => (
          <h3 className="mb-2 mt-3 text-base font-semibold text-gray-200">{children}</h3>
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
            <code className="rounded bg-gray-800 px-1 py-0.5 font-mono text-sm text-blue-300">
              {children}
            </code>
          )
        },
        pre: ({ children }) => <pre className="mb-0">{children}</pre>,
        ul: ({ children }) => (
          <ul className="mb-2 list-disc pl-5 text-gray-300">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="mb-2 list-decimal pl-5 text-gray-300">{children}</ol>
        ),
        li: ({ children }) => <li className="mb-1">{children}</li>,
        blockquote: ({ children }) => (
          <blockquote className="mb-2 border-l-2 border-gray-600 pl-3 text-gray-400">
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
          <th className="border border-gray-700 bg-gray-800 px-3 py-2 text-left font-semibold text-gray-200">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border border-gray-700 px-3 py-2 text-gray-300">{children}</td>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  )
}
