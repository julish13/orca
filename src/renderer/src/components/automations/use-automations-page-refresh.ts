import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { useAppStore } from '@/store/index'
import type { PendingAutomationRunNavigation } from '@/store/slices/ui/ui-slice-contract-core'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { AUTOMATIONS_CHANGED_EVENT } from '@/components/automations/events/automations-changed-window-event'
import {
  getAutomationHostTargetKey,
  getAutomationListedTargetFromHostId,
  listAutomationsForTarget
} from './hosts/automation-host-client'
import { automationAuthorityCatalogKey } from './hosts/automation-host-catalog-types'
import { resolveAutomationRunLinkRow } from './runs/automation-run-link-row'
import { useSelectedAutomationRunHistory } from './runs/use-selected-automation-run-history'
import type { AutomationsPageDestinationState } from './authoring/use-automations-page-destination-state'
import type { AutomationsPageListState } from './listing/use-automations-page-list-state'
import type { AutomationsPageLocalState } from './use-automations-page-local-state'
import type { AutomationsPageStoreState } from './use-automations-page-store-state'

// Backoff before each retry of a pending link's host listing; after the last one the link is dropped.
const PENDING_LISTING_RETRY_DELAYS_MS = [500, 1000, 2000]

type PendingListingFailures = {
  navigation: PendingAutomationRunNavigation | null
  count: number
}

function dropUnreachablePendingNavigation(navigation: PendingAutomationRunNavigation): void {
  const state = useAppStore.getState()
  state.setPendingAutomationRunNavigation(null)
  toast.error(
    translate('automations.hostUnreachable', "Couldn't reach {{host}}. Try again once it's back.", {
      host: selectExecutionHostDisplayLabel(state, navigation.hostId ?? LOCAL_EXECUTION_HOST_ID)
    })
  )
}

/** Refreshes host-scoped rows and wires lifecycle/selection history effects. */
export function useAutomationsPageRefresh({
  store,
  local,
  list,
  destination
}: {
  store: AutomationsPageStoreState
  local: AutomationsPageLocalState
  list: AutomationsPageListState
  destination: AutomationsPageDestinationState
}) {
  const {
    fetchAllWorktrees,
    startupWorktreeRefreshCompleted,
    pendingAutomationRunNavigation,
    runtimeEnvironments
  } = store
  const {
    setIsLoading,
    setAutomations,
    setAutomationHostTargetKey,
    setFailedAuthorityKeys,
    setPageView,
    isLoading,
    automationHostTargetKey,
    setRelativeNow,
    runHistoryReloadToken,
    blockedRunHistory,
    setBlockedRunHistory
  } = local
  const { scopedExternal, selectedRow, boundRun } = list
  const { automationHostTargetFor } = destination
  const pendingTargetKey = pendingAutomationRunNavigation
    ? getAutomationHostTargetKey(
        getAutomationListedTargetFromHostId(pendingAutomationRunNavigation.hostId, {
          runtimeEnvironments
        })
      )
    : null
  const reloadExternalManagers = scopedExternal.reload
  // Only listings the pending link itself started count, so a failed focus refresh never drops it.
  const [pendingListingFailures, setPendingListingFailures] = useState<PendingListingFailures>({
    navigation: null,
    count: 0
  })

  const refresh = useCallback(
    async (options?: {
      awaitExternalManagers?: boolean
      forPendingNavigation?: boolean
    }): Promise<void> => {
      setIsLoading(true)
      const pendingNavigation = useAppStore.getState().pendingAutomationRunNavigation
      // Until navigation names a host, only the desktop’s legacy unscoped arm can be addressed without guessing.
      const target = pendingNavigation
        ? getAutomationListedTargetFromHostId(pendingNavigation.hostId, useAppStore.getState())
        : { kind: 'local' as const }
      const authorityKey = automationAuthorityCatalogKey(
        target.kind === 'environment'
          ? { kind: 'runtime', environmentId: target.environmentId }
          : { kind: 'desktop' }
      )
      const managersSettled = reloadExternalManagers().catch(() => undefined)
      try {
        const nextAutomations = await listAutomationsForTarget(target)
        // A bot's waits are listed in its sidebar, never with automations.
        setAutomations(nextAutomations.filter((automation) => !automation.once))
        setAutomationHostTargetKey(getAutomationHostTargetKey(target))
        setFailedAuthorityKeys((current) => {
          if (!current.has(authorityKey)) {
            return current
          }
          const next = new Set(current)
          next.delete(authorityKey)
          return next
        })
      } catch {
        setFailedAuthorityKeys((current) => new Set(current).add(authorityKey))
        if (
          options?.forPendingNavigation &&
          pendingNavigation &&
          useAppStore.getState().pendingAutomationRunNavigation === pendingNavigation
        ) {
          setPendingListingFailures((current) => ({
            navigation: pendingNavigation,
            count: current.navigation === pendingNavigation ? current.count + 1 : 1
          }))
        }
      } finally {
        setIsLoading(false)
      }
      if (options?.awaitExternalManagers) {
        await managersSettled
      }
    },
    [
      reloadExternalManagers,
      setAutomations,
      setAutomationHostTargetKey,
      setFailedAuthorityKeys,
      setIsLoading
    ]
  )

  const hydratePersistedUIState = useCallback(async (): Promise<void> => {
    useAppStore.getState().hydratePersistedUI(await window.api.ui.get(), 'sync')
  }, [])

  const mountedBeforeStartupWorktreeRefreshRef = useRef(!startupWorktreeRefreshCompleted)
  useEffect(() => {
    if (!startupWorktreeRefreshCompleted) {
      return
    }
    if (mountedBeforeStartupWorktreeRefreshRef.current) {
      mountedBeforeStartupWorktreeRefreshRef.current = false
      return
    }
    void fetchAllWorktrees()
  }, [fetchAllWorktrees, startupWorktreeRefreshCompleted])
  useEffect(() => {
    void refresh()
  }, [refresh])
  useEffect(() => {
    return installWindowVisibilityInterval({
      run: () => setRelativeNow(Date.now()),
      intervalMs: 60 * 1000
    })
  }, [setRelativeNow])
  useEffect(() => {
    if (!pendingAutomationRunNavigation || isLoading) {
      return
    }
    if (automationHostTargetKey === pendingTargetKey) {
      return
    }
    const failureCount =
      pendingListingFailures.navigation === pendingAutomationRunNavigation
        ? pendingListingFailures.count
        : 0
    if (failureCount > PENDING_LISTING_RETRY_DELAYS_MS.length) {
      if (
        useAppStore.getState().pendingAutomationRunNavigation === pendingAutomationRunNavigation
      ) {
        if (
          pendingAutomationRunNavigation.ownerKey &&
          blockedRunHistory !== pendingAutomationRunNavigation
        ) {
          setBlockedRunHistory(pendingAutomationRunNavigation)
          return
        }
        dropUnreachablePendingNavigation(pendingAutomationRunNavigation)
        setPageView('automations')
      }
      return
    }
    if (failureCount === 0) {
      void refresh({ forPendingNavigation: true })
      return
    }
    const timer = window.setTimeout(
      () => void refresh({ forPendingNavigation: true }),
      PENDING_LISTING_RETRY_DELAYS_MS[failureCount - 1]
    )
    return () => window.clearTimeout(timer)
  }, [
    automationHostTargetKey,
    blockedRunHistory,
    isLoading,
    pendingAutomationRunNavigation,
    pendingTargetKey,
    pendingListingFailures,
    refresh,
    setBlockedRunHistory,
    setPageView
  ])
  // A failed visit only blocks its own row. An unscoped fallback cannot distinguish colliding rows.
  const historyBlocked =
    blockedRunHistory !== null &&
    selectedRow !== null &&
    selectedRow.automation.id === blockedRunHistory.automationId &&
    (!selectedRow.catalogRef ||
      !blockedRunHistory.rowKey ||
      selectedRow.key === blockedRunHistory.rowKey)
  const ownerlessRun =
    pendingAutomationRunNavigation?.runId && !pendingAutomationRunNavigation.ownerKey
      ? pendingAutomationRunNavigation
      : null
  // Only the addressed row can resolve an ownerless link to a current owner.
  const waitingForOwnerlessRow =
    ownerlessRun &&
    (!pendingTargetKey ||
      isLoading ||
      automationHostTargetKey !== pendingTargetKey ||
      !selectedRow ||
      !local.automations.some((automation) => automation.id === ownerlessRun.automationId) ||
      resolveAutomationRunLinkRow(
        ownerlessRun,
        list.visibleRows,
        list.hostCatalog.rows.capturedOwners,
        pendingTargetKey
      ).row?.key !== selectedRow.key)
  useSelectedAutomationRunHistory({
    selected: selectedRow,
    selection: { automationId: store.selectedId, rowKey: local.selectedRowKey },
    retained: local.selectedAutomationRuns,
    context: destination.automationDispatchContext,
    legacyTarget: automationHostTargetFor,
    navigation: waitingForOwnerlessRow ? null : pendingAutomationRunNavigation,
    suspended:
      (boundRun !== null && selectedRow === null) ||
      (pendingAutomationRunNavigation?.ownerKey
        ? isLoading || automationHostTargetKey !== pendingTargetKey
        : historyBlocked && !pendingAutomationRunNavigation),
    reloadToken: runHistoryReloadToken,
    acquisitionToken: local.runHistoryAcquisitionToken,
    onStarted: local.startSelectedRunHistory,
    onSettled: local.settleSelectedRunHistory
  })
  useEffect(() => {
    const onAutomationsChanged = (): void => {
      void refresh()
    }
    window.addEventListener(AUTOMATIONS_CHANGED_EVENT, onAutomationsChanged)
    return () => window.removeEventListener(AUTOMATIONS_CHANGED_EVENT, onAutomationsChanged)
  }, [refresh])
  useEffect(() => {
    const onVisibilityOrFocus = (): void => {
      if (document.visibilityState === 'visible') {
        void refresh()
      }
    }
    window.addEventListener('focus', onVisibilityOrFocus)
    document.addEventListener('visibilitychange', onVisibilityOrFocus)
    return () => {
      window.removeEventListener('focus', onVisibilityOrFocus)
      document.removeEventListener('visibilitychange', onVisibilityOrFocus)
    }
  }, [refresh])

  return { getDefaultTarget: destination.getDefaultTarget, refresh, hydratePersistedUIState }
}

export type AutomationsPageRefresh = ReturnType<typeof useAutomationsPageRefresh>
