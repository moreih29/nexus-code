import { usePanelData } from '../../stores/plugin-store'

// ─── 타입 정의 ─────────────────────────────────────────────────────────────

interface ConsultData {
  title?: string
  status?: string
  items?: Array<{ label: string; value?: string }>
  [key: string]: unknown
}

interface DecisionEntry {
  id?: string
  title?: string
  decision?: string
  rationale?: string
  timestamp?: string
  [key: string]: unknown
}

interface TaskEntry {
  id?: string | number
  subject?: string
  status?: string
  owner?: string
  [key: string]: unknown
}

// ─── 공통 서브컴포넌트 ─────────────────────────────────────────────────────

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="mb-2 border-b border-border pb-1">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</span>
    </div>
  )
}

function EmptyState({ label }: { label: string }) {
  return <p className="text-xs text-dim-foreground">{label}</p>
}

// ─── Consult 패널 ──────────────────────────────────────────────────────────

function ConsultSection() {
  const data = usePanelData<ConsultData>('nexus', 'consult')

  if (!data) return <EmptyState label="consult.json 없음" />

  return (
    <div className="space-y-1">
      {data.title && (
        <p className="text-sm font-medium text-foreground">{data.title}</p>
      )}
      {data.status && (
        <span className="inline-block rounded bg-blue-900/50 px-2 py-0.5 text-xs text-blue-300">
          {data.status}
        </span>
      )}
      {data.items?.map((item, i) => (
        <div key={i} className="flex gap-2 text-xs">
          <span className="shrink-0 text-muted-foreground">{item.label}:</span>
          <span className="text-foreground">{item.value ?? '—'}</span>
        </div>
      ))}
      {!data.title && !data.items && (
        <pre className="whitespace-pre-wrap break-all text-xs text-muted-foreground">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  )
}

// ─── Decisions 패널 ────────────────────────────────────────────────────────

function DecisionsSection() {
  const raw = usePanelData<unknown>('nexus', 'decisions')

  const entries: DecisionEntry[] = Array.isArray(raw)
    ? (raw as DecisionEntry[])
    : raw && typeof raw === 'object' && 'decisions' in (raw as object)
      ? ((raw as { decisions: DecisionEntry[] }).decisions ?? [])
      : []

  if (entries.length === 0) return <EmptyState label="결정 사항 없음" />

  return (
    <div className="space-y-3">
      {entries.map((d, i) => (
        <div key={d.id ?? i} className="rounded border border-border bg-muted/40 p-2">
          <p className="text-sm font-medium text-foreground">{d.title ?? d.decision ?? `Decision #${i + 1}`}</p>
          {d.rationale && (
            <p className="mt-1 text-xs text-muted-foreground">{d.rationale}</p>
          )}
          {d.timestamp && (
            <p className="mt-1 text-xs text-dim-foreground">{d.timestamp}</p>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Tasks 패널 ────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  completed: 'text-green-400',
  in_progress: 'text-blue-400',
  pending: 'text-muted-foreground',
  deleted: 'text-red-400',
}

function TasksSection() {
  const raw = usePanelData<unknown>('nexus', 'tasks')

  const entries: TaskEntry[] = Array.isArray(raw)
    ? (raw as TaskEntry[])
    : raw && typeof raw === 'object' && 'tasks' in (raw as object)
      ? ((raw as { tasks: TaskEntry[] }).tasks ?? [])
      : []

  if (entries.length === 0) return <EmptyState label="태스크 없음" />

  return (
    <div className="space-y-1">
      {entries.map((t, i) => {
        const statusColor = STATUS_COLORS[t.status ?? ''] ?? 'text-muted-foreground'
        return (
          <div key={t.id ?? i} className="flex items-start gap-2 rounded px-1 py-1 hover:bg-muted/40">
            <span className={`mt-0.5 shrink-0 text-xs font-mono ${statusColor}`}>
              [{t.status ?? '?'}]
            </span>
            <span className="text-xs text-foreground">{t.subject ?? `Task #${i + 1}`}</span>
            {t.owner && (
              <span className="ml-auto shrink-0 text-xs text-dim-foreground">{String(t.owner)}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── NexusPanel (메인) ─────────────────────────────────────────────────────

export function NexusPanel() {
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-3">
      <section>
        <SectionHeader title="Consultation" />
        <ConsultSection />
      </section>
      <section>
        <SectionHeader title="Decisions" />
        <DecisionsSection />
      </section>
      <section>
        <SectionHeader title="Tasks" />
        <TasksSection />
      </section>
    </div>
  )
}
