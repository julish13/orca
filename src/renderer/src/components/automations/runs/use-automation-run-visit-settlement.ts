import { useCallback, useEffect } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import type { AutomationCapturedOwner } from '../hosts/automation-captured-owner'
import type { AutomationsPageLocalState } from '../use-automations-page-local-state'
import {
  automationRunLinkOwnerChanged,
  reportReplacedAutomationRunOwner
} from './automation-run-link-row'

export function useAutomationRunVisitSettlement(
  {
    pageView,
    runNotFound,
    runVisit,
    runPageOrigin,
    selectedAutomationRuns,
    settledRunHistoryRef,
    selectedAutomationRunPageId,
    setRunNotFound,
    setBlockedRunHistory,
    setRunVisit,
    setSelectedAutomationRunPageId,
    setIsDetailOpen,
    setPageView
  }: Pick<
    AutomationsPageLocalState,
    | 'pageView'
    | 'runNotFound'
    | 'runVisit'
    | 'runPageOrigin'
    | 'selectedAutomationRuns'
    | 'settledRunHistoryRef'
    | 'selectedAutomationRunPageId'
    | 'setRunNotFound'
    | 'setBlockedRunHistory'
    | 'setRunVisit'
    | 'setSelectedAutomationRunPageId'
    | 'setIsDetailOpen'
    | 'setPageView'
  >,
  capturedOwners: ReadonlyMap<string, AutomationCapturedOwner>,
  missingRun: boolean
): () => void {
  const t = useTranslate()
  const leaveReplacedRun = useCallback((): void => {
    setRunVisit(null)
    setSelectedAutomationRunPageId(null)
    setIsDetailOpen(false)
    setPageView('automations')
    reportReplacedAutomationRunOwner(t)
  }, [setRunVisit, setSelectedAutomationRunPageId, setIsDetailOpen, setPageView, t])

  useEffect(() => {
    if (
      pageView !== 'run' ||
      runNotFound ||
      !runVisit ||
      useAppStore.getState().pendingAutomationRunNavigation
    ) {
      return
    }
    if (automationRunLinkOwnerChanged(runVisit, capturedOwners)) {
      setBlockedRunHistory(runVisit)
      leaveReplacedRun()
    } else if (
      missingRun &&
      selectedAutomationRunPageId &&
      settledRunHistoryRef.current === selectedAutomationRuns
    ) {
      setRunNotFound({
        ...runVisit,
        kind: 'run',
        runId: selectedAutomationRunPageId,
        origin: runPageOrigin
      })
      setSelectedAutomationRunPageId(null)
    }
  }, [
    pageView,
    runNotFound,
    runVisit,
    runPageOrigin,
    selectedAutomationRuns,
    settledRunHistoryRef,
    selectedAutomationRunPageId,
    missingRun,
    capturedOwners,
    setBlockedRunHistory,
    leaveReplacedRun,
    setRunNotFound,
    setSelectedAutomationRunPageId
  ])

  return leaveReplacedRun
}
