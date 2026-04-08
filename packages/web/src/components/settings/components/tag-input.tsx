import { useState } from 'react'
import { X } from 'lucide-react'

export function TagInput({
  values,
  onChange,
  placeholder,
  inputId,
}: {
  values: string[]
  onChange: (values: string[]) => void
  placeholder?: string
  inputId: string
}) {
  const [inputValue, setInputValue] = useState('')

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if ((e.key === 'Enter' || e.key === ',') && inputValue.trim()) {
      e.preventDefault()
      const newVal = inputValue.trim().replace(/,$/, '')
      if (newVal && !values.includes(newVal)) {
        onChange([...values, newVal])
      }
      setInputValue('')
    } else if (e.key === 'Backspace' && !inputValue && values.length > 0) {
      onChange(values.slice(0, -1))
    }
  }

  function removeTag(idx: number) {
    onChange(values.filter((_, i) => i !== idx))
  }

  return (
    <div
      className="flex flex-wrap gap-1 min-h-7 w-full p-1 rounded border border-[var(--border)] bg-[var(--bg-base)] focus-within:border-[var(--accent)] cursor-text"
      onClick={() => {
        const input = document.getElementById(inputId) as HTMLInputElement | null
        input?.focus()
      }}
    >
      {values.map((v, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-secondary)] text-[10px]"
        >
          {v}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); removeTag(i) }}
            className="hover:text-[var(--red)]"
          >
            <X className="size-2.5" />
          </button>
        </span>
      ))}
      <input
        id={inputId}
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={values.length === 0 ? placeholder : ''}
        className="flex-1 min-w-12 bg-transparent text-[10px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
      />
    </div>
  )
}
