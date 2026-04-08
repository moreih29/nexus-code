import { cn } from '@/lib/utils'
import { TagInput } from './tag-input'

const BUILTIN_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Agent',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
] as const

type BuiltinTool = (typeof BUILTIN_TOOLS)[number]

export function DisallowedToolsInput({
  values,
  onChange,
}: {
  values: string[]
  onChange: (values: string[]) => void
}) {
  const builtinBlocked = new Set(values.filter((v) => (BUILTIN_TOOLS as readonly string[]).includes(v)))
  const customValues = values.filter((v) => !(BUILTIN_TOOLS as readonly string[]).includes(v))

  function toggleBuiltin(tool: BuiltinTool) {
    const next = new Set(builtinBlocked)
    if (next.has(tool)) {
      next.delete(tool)
    } else {
      next.add(tool)
    }
    onChange([...next, ...customValues])
  }

  function handleCustomChange(vals: string[]) {
    onChange([...builtinBlocked, ...vals])
  }

  return (
    <div className="w-full rounded border border-[var(--border)] bg-[var(--bg-base)] p-2 space-y-2">
      <div className="grid grid-cols-3 gap-x-3 gap-y-1">
        {BUILTIN_TOOLS.map((tool) => (
          <label
            key={tool}
            className="flex items-center gap-1.5 cursor-pointer group"
          >
            <input
              type="checkbox"
              checked={builtinBlocked.has(tool)}
              onChange={() => toggleBuiltin(tool)}
              className="w-3 h-3 rounded border border-[var(--border)] accent-[var(--accent)] cursor-pointer"
            />
            <span className={cn(
              'text-[10px] transition-colors',
              builtinBlocked.has(tool)
                ? 'text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] group-hover:text-[var(--text-secondary)]'
            )}>
              {tool}
            </span>
          </label>
        ))}
      </div>
      <div className="border-t border-[var(--border)] pt-2">
        <span className="text-[10px] text-[var(--text-muted)] block mb-1">커스텀</span>
        <TagInput
          inputId="tag-disallowed-tools-custom"
          values={customValues}
          onChange={handleCustomChange}
          placeholder="MCP 도구 등..."
        />
        <p className="text-[10px] text-[var(--text-muted)] mt-1">
          Enter 또는 쉼표로 추가
        </p>
      </div>
    </div>
  )
}
