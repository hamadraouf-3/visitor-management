import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fetchInsideListNow, useInsideList } from '../../api/queries'
import { queryKeys } from '../../api/queryKeys'
import { useToast } from '../../components/ui/toastContext'
import { formatClockTime } from '../../utils/datetime'

export interface InsideListActions {
  /** The inside list (GET /reception/inside, polled). */
  list: ReturnType<typeof useInsideList>
  /** "Refresh": reload the list now. */
  refresh: () => Promise<void>
  refreshing: boolean
  /** "Print list": reload the list, then print once the reloaded list is on screen. */
  print: () => Promise<void>
  preparingPrint: boolean
}

/**
 * The evacuation list's Refresh and Print (§10, D-25). Both are a person's own request, so
 * they are sent without the background header (§7.2). "Print" first fetches the current list
 * and prints only once that list is rendered (the refreshed data renders one notification
 * after the request resolves); each request prints once. When the list cannot be refreshed,
 * the last one is printed and a toast says from when it is.
 */
export function usePrintWhenFresh(timeZone: string): InsideListActions {
  const { t } = useTranslation('inside')
  const queryClient = useQueryClient()
  const toast = useToast()
  const list = useInsideList()
  const [refreshing, setRefreshing] = useState(false)
  const [preparingPrint, setPreparingPrint] = useState(false)
  // Print once the list from at least `after` is on screen.
  const [printRequest, setPrintRequest] = useState<{ id: number; after: number } | null>(null)
  const printed = useRef(0)

  useEffect(() => {
    if (!printRequest || printed.current === printRequest.id || list.dataUpdatedAt < printRequest.after) return
    printed.current = printRequest.id
    window.print()
  }, [printRequest, list.dataUpdatedAt])

  const refresh = async () => {
    setRefreshing(true)
    try {
      await fetchInsideListNow(queryClient)
    } catch {
      // The query shows the failure and keeps the last list; nothing else to do here.
    } finally {
      setRefreshing(false)
    }
  }

  const print = async () => {
    setPreparingPrint(true)
    try {
      await fetchInsideListNow(queryClient)
      const after = queryClient.getQueryState(queryKeys.reception.inside)?.dataUpdatedAt ?? 0
      setPrintRequest((current) => ({ id: (current?.id ?? 0) + 1, after }))
    } catch {
      if (!list.data) return
      toast.show({
        tone: 'warning',
        title: t('printStale.title'),
        description: t('printStale.description', { time: formatClockTime(list.dataUpdatedAt, timeZone) }),
      })
      setPrintRequest((current) => ({ id: (current?.id ?? 0) + 1, after: 0 }))
    } finally {
      setPreparingPrint(false)
    }
  }

  return { list, refresh, refreshing, print, preparingPrint }
}
