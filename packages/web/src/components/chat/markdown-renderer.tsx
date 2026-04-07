import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'

const components: Components = {
  p({ children }) {
    return <p className="mb-[0.6em] last:mb-0 leading-[1.6]">{children}</p>
  },
  strong({ children }) {
    return <strong className="font-semibold text-text-primary">{children}</strong>
  },
  em({ children }) {
    return <em className="italic">{children}</em>
  },
  code({ children, className }) {
    const isBlock = className?.startsWith('language-')
    if (isBlock) {
      return (
        <code
          className="block font-mono text-[12px] leading-[1.5]"
          style={{ color: 'var(--text-primary)' }}
        >
          {children}
        </code>
      )
    }
    return (
      <code
        className="font-mono text-[12px] rounded px-[4px] py-[2px]"
        style={{
          background: 'var(--bg-elevated)',
          color: 'var(--accent)',
          border: '1px solid var(--border)',
        }}
      >
        {children}
      </code>
    )
  },
  pre({ children }) {
    return (
      <pre
        className="rounded-[6px] px-[12px] py-[10px] my-[0.6em] overflow-x-auto text-[12px] leading-[1.5]"
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
        }}
      >
        {children}
      </pre>
    )
  },
  ul({ children }) {
    return <ul className="list-disc pl-[1.4em] mb-[0.6em] last:mb-0 space-y-[2px]">{children}</ul>
  },
  ol({ children }) {
    return <ol className="list-decimal pl-[1.4em] mb-[0.6em] last:mb-0 space-y-[2px]">{children}</ol>
  },
  li({ children }) {
    return <li className="leading-[1.6]">{children}</li>
  },
  h1({ children }) {
    return (
      <h1 className="text-[16px] font-semibold text-text-primary mb-[0.4em] mt-[0.8em] first:mt-0 leading-snug">
        {children}
      </h1>
    )
  },
  h2({ children }) {
    return (
      <h2 className="text-[14px] font-semibold text-text-primary mb-[0.4em] mt-[0.8em] first:mt-0 leading-snug">
        {children}
      </h2>
    )
  },
  h3({ children }) {
    return (
      <h3 className="text-[13px] font-semibold text-text-primary mb-[0.3em] mt-[0.6em] first:mt-0 leading-snug">
        {children}
      </h3>
    )
  },
  blockquote({ children }) {
    return (
      <blockquote
        className="pl-[12px] my-[0.6em] italic text-text-secondary"
        style={{ borderLeft: '3px solid var(--border)' }}
      >
        {children}
      </blockquote>
    )
  },
  a({ children, href }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2"
        style={{ color: 'var(--accent)' }}
      >
        {children}
      </a>
    )
  },
  hr() {
    return <hr className="my-[0.8em]" style={{ borderColor: 'var(--border)' }} />
  },
  table({ children }) {
    return (
      <div className="overflow-x-auto my-[0.6em]">
        <table
          className="w-full text-[12px] border-collapse"
          style={{ border: '1px solid var(--border)' }}
        >
          {children}
        </table>
      </div>
    )
  },
  thead({ children }) {
    return (
      <thead style={{ background: 'var(--bg-elevated)' }}>{children}</thead>
    )
  },
  th({ children }) {
    return (
      <th
        className="px-[10px] py-[6px] text-left font-semibold text-text-primary"
        style={{ border: '1px solid var(--border)' }}
      >
        {children}
      </th>
    )
  },
  td({ children }) {
    return (
      <td
        className="px-[10px] py-[6px] text-text-secondary"
        style={{ border: '1px solid var(--border)' }}
      >
        {children}
      </td>
    )
  },
}

interface MarkdownRendererProps {
  children: string
}

export function MarkdownRenderer({ children }: MarkdownRendererProps) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </ReactMarkdown>
  )
}
