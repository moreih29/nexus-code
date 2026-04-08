import { cn } from '@/lib/utils'
import { useTheme, THEMES } from '@/hooks/use-theme'
import { SectionHeader } from '../components/section-header'

export function AppTab() {
  const { theme, setTheme } = useTheme()

  return (
    <section>
      <SectionHeader>테마</SectionHeader>
      <div className="grid grid-cols-4 gap-2">
        {THEMES.map((t) => (
          <button
            key={t.id}
            onClick={() => setTheme(t.id)}
            className={cn(
              'rounded-md border transition-colors text-left overflow-hidden',
              theme === t.id
                ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]'
                : 'border-[var(--border)] hover:border-[var(--text-muted)]'
            )}
          >
            {/* Swatch: accent strip (top) + bg strip (bottom) */}
            <div className="relative">
              <div
                className="h-5 w-full"
                style={{ backgroundColor: t.palette[2] }}
              >
                {/* Semantic color dot on accent strip */}
                <span
                  className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full border border-black/20"
                  style={{ backgroundColor: t.palette[3] }}
                />
              </div>
              <div className="h-3 w-full flex">
                <div className="flex-1" style={{ backgroundColor: t.palette[0] }} />
                <div className="flex-1" style={{ backgroundColor: t.palette[1] }} />
              </div>
            </div>
            <span className="block px-2 py-1.5 text-[10px] text-[var(--text-muted)]">
              {t.label}
            </span>
          </button>
        ))}
      </div>
      <p className="text-[10px] text-[var(--text-muted)] mt-3">
        테마 변경은 즉시 적용됩니다
      </p>
    </section>
  )
}
