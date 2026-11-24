import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'

export function AutomationRunHistoryLoading({
  className
}: {
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      role="status"
      className={cn(
        'flex items-center justify-center gap-2 text-sm text-muted-foreground',
        className
      )}
    >
      <LoadingSpinner className="size-4" />
      {t('auto.components.automations.AutomationRunsDashboard.loading', 'Loading runs…')}
    </div>
  )
}
