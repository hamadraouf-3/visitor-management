import { hashKey, useQueryClient } from '@tanstack/react-query'
import { CalendarPlus, Download, ExternalLink } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getErrorMessage } from '../../api/client'
import { queryKeys } from '../../api/queryKeys'
import { buttonClassName } from '../../components/ui/buttonStyles'
import { Menu, type MenuControl, type MenuItem } from '../../components/ui/Menu'
import { useToast } from '../../components/ui/toastContext'
import { useLanguage } from '../../i18n/useLanguage'
import type { Me, Visit } from '../../types/api'
import { downloadTextFile } from '../../utils/download'
import { focusPageHeading, isFocusLost } from '../../utils/focus'
import { googleCalendarUrl, hostCalendarEvent, hostCalendarFile, hostCalendarFileName, offersHostCalendar, outlookCalendarUrl } from './hostCalendar'
import { fetchVisitNow } from './useVisitDetail'

export interface AddToCalendarProps {
  /** The visit on the page: which one. What goes into the calendar is the visit as it is when the menu opens. */
  visit: Visit
  me: Me
  className?: string
}

/** What a calendar entry of the visit is written from: its times and its revision. */
function versionOf(visit: Visit): string {
  return `${visit.updated_at}|${visit.calendar_sequence}`
}

/**
 * "Add to my calendar" (Phase 14, F14-1): the host's event of the visit, for Google Calendar and Outlook
 * on the web (their new-event form, in a new tab) and as an `.ics` file for Apple Calendar and the rest.
 * The kit's menu button; the caller decides when it is offered (`offersHostCalendar`). Full width on
 * phones, as the page's other actions there.
 *
 * Made from the visit as it is now (F14-15): the page's copy may be older than a new time or a
 * cancellation made elsewhere, which would put the old times and the old SEQUENCE into a calendar, or
 * add back a cancelled visit. So opening the menu fetches the visit again (the kit's loading state
 * meanwhile, its error toast on a failure), and the links and the file are written from that visit,
 * and only when it still qualifies. When it no longer does, nothing opens: the page's copy is updated by
 * the same fetch, this control goes, and its focus goes on from the page's heading. A visit that changes
 * while the menu is open closes it (F14-28): its links and file would say the old time.
 */
export function AddToCalendar({ visit, me, className }: AddToCalendarProps) {
  const { t } = useTranslation('visits')
  const { language } = useLanguage()
  const queryClient = useQueryClient()
  const toast = useToast()
  const container = useRef<HTMLDivElement>(null)
  // The visit this control was withdrawn from: gone at once, whenever the page drops it.
  const [withdrawnFrom, setWithdrawnFrom] = useState<string | null>(null)
  const menu = useRef<MenuControl>(null)
  // The version of the visit the menu's items were written from (null while they are being made).
  const builtFrom = useRef<string | null>(null)
  // Whether the focus is on this control (its trigger or its menu), and whether it is still on the page.
  const focusInside = useRef(false)
  const mounted = useRef(false)

  // Every change of the page's copy of the visit (a refetch, a poll, another of this page's actions): one
  // that is not the version the items were written from closes the menu, whose links and file would
  // say the old time (F14-28).
  useEffect(() => {
    const visitHash = hashKey(queryKeys.visits.detail(visit.id))
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.query.queryHash !== visitHash || builtFrom.current === null) return
      const data = event.query.state.data as Visit | undefined
      if (!data || versionOf(data) === builtFrom.current) return
      builtFrom.current = null
      menu.current?.close()
    })
  }, [queryClient, visit.id])

  // The page dropped this control under the focus (the visit changed, or the page turned to "not
  // found" or "no access" on the menu's request): the focus goes on from the page's heading.
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (focusInside.current && isFocusLost()) focusPageHeading()
    }
  }, [])

  const loadItems = async (): Promise<MenuItem[] | null> => {
    builtFrom.current = null
    try {
      const current = await fetchVisitNow(queryClient, visit.id)
      if (!offersHostCalendar(current, me.user.id, Date.now())) {
        if (container.current?.contains(document.activeElement)) focusPageHeading()
        setWithdrawnFrom(visit.id)
        return null
      }
      // Written here, never while the page renders: a time the browser cannot read fails this, not the page.
      const event = hostCalendarEvent(current, me.company, language)
      const file = hostCalendarFile(event)
      const fileName = hostCalendarFileName(current, me.company.timezone)
      builtFrom.current = versionOf(current)
      return [
        { id: 'google', label: t('calendar.google'), icon: ExternalLink, href: googleCalendarUrl(event) },
        { id: 'outlook', label: t('calendar.outlook'), icon: ExternalLink, href: outlookCalendarUrl(event) },
        { id: 'ics', label: t('calendar.file'), icon: Download, onSelect: () => downloadTextFile(file, fileName, 'text/calendar;charset=utf-8') },
      ]
    } catch (error) {
      // Not after the host left the page: the next page is not about this visit.
      if (mounted.current) toast.show({ tone: 'danger', title: t('detail.loadError'), description: getErrorMessage(error) })
      return null
    }
  }

  if (withdrawnFrom === visit.id) return null
  return (
    <div
      ref={container}
      className={className}
      onFocus={() => {
        focusInside.current = true
      }}
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) focusInside.current = false
      }}
    >
      <Menu
        trigger={t('calendar.add')}
        triggerIcon={<CalendarPlus aria-hidden="true" />}
        triggerClassName={buttonClassName({ variant: 'secondary', className: 'w-full sm:w-auto' })}
        loadItems={loadItems}
        controlRef={menu}
        fitContent
      />
    </div>
  )
}
