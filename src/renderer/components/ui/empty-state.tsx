import { cn } from '@renderer/lib/utils'

interface EmptyStateProps {
  icon?: React.ReactNode
  title?: string
  description?: string
  action?: { label: string; onClick: () => void }
  size?: 'sm' | 'md'
  className?: string
}

export function EmptyState({ icon, title, description, action, size = 'md', className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center h-full', size === 'sm' ? 'gap-2' : 'gap-3', className)}>
      {icon && (
        <div className={cn(size === 'sm' ? 'h-6 w-6 opacity-30' : 'h-8 w-8 opacity-30')}>
          {icon}
        </div>
      )}
      {title && (
        <p className={cn(size === 'sm' ? 'text-xs text-dim-foreground' : 'text-base text-foreground')}>
          {title}
        </p>
      )}
      {description && (
        <p className="text-sm text-muted-foreground">{description}</p>
      )}
      {action && (
        <button
          onClick={action.onClick}
          className="mt-1 rounded-md px-3 py-1.5 text-sm text-primary hover:bg-primary/10 transition-colors"
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
