import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useAuth } from '../../../auth/useAuth'
import { useToast } from '../../../components/ui/toastContext'
import { setTitlePrefix } from '../../../hooks/documentTitle'
import { useLanguage } from '../../../i18n/useLanguage'
import { paths } from '../../../paths'
import { locationName } from '../locationNames'
import { closeBrowserNotifications, readAlertPreferences, showBrowserNotification } from './alertPreferences'
import { alertTitlePrefix, watchSummary, type WatchStep } from './alertWatch'
import { beep, installAudioUnlock } from './beep'
import { useTrackingAlertSummary } from './queries'

/**
 * The tracking alerts' watcher (Phase 16), run by the company shell for administrators, management and
 * reception while the company's tracking is allowed. It asks for the alerts' counts every 15 s, also in a
 * background tab. A new open alert (or one escalated to a restricted area) is told of once: a danger toast
 * «تنبيه: {visitor} في {floor › zone}» with «عرض» / "View" (the visit's journey), a short beep when the
 * viewer's sound is on, and a notification of the operating system when the viewer turned them on and the
 * browser allows them. The first answer only sets the counts. While alerts are open the tab's title starts
 * with "(n) ". Draws nothing on the page itself. Mounted per person (F16-14): when it goes (signing out, the
 * session ended, another person, tracking withdrawn) it takes its title's count and the operating system's
 * notifications it showed with it (F16-39).
 */
export function TrackingAlertWatcher() {
  const { t } = useTranslation('journey')
  const { me } = useAuth()
  const { language } = useLanguage()
  const toast = useToast()
  const navigate = useNavigate()
  const summary = useTrackingAlertSummary({ poll: true })
  const watched = useRef<Pick<WatchStep, 'seen' | 'cutoff'> | null>(null)
  const userId = me?.user.id ?? null
  const data = summary.data

  useEffect(() => installAudioUnlock(), [])

  // Each answer the server gives (an unchanged one keeps its reference and is not looked at again).
  useEffect(() => {
    if (!data || userId === null) return
    const step = watchSummary(data, watched.current)
    watched.current = { seen: step.seen, cutoff: step.cutoff }
    if (step.fresh.length === 0) return
    const preferences = readAlertPreferences(userId)
    // Oldest first, so the newest toast is the last one said.
    for (const brief of step.fresh.toReversed()) {
      const place = `${locationName(brief.location.floor, language)} › ${locationName(brief.location.zone, language)}`
      const title = t('alerts.toast', { name: brief.visitor_name, place })
      const open = () => void navigate(paths.journeyVisit(brief.visit_id))
      toast.show({
        tone: 'danger',
        title,
        description: brief.simulated ? t('simulated') : undefined,
        action: { label: t('alerts.view'), onAction: open },
      })
      if (preferences.notifications) showBrowserNotification(title, { body: brief.simulated ? t('simulated') : undefined, tag: brief.id, lang: language, onClick: open })
    }
    if (preferences.sound) beep()
  }, [data, userId, language, navigate, t, toast])

  const open = data?.open ?? 0
  useEffect(() => setTitlePrefix(alertTitlePrefix(open)), [open])
  useEffect(
    () => () => {
      setTitlePrefix('')
      // A visitor's name and place must not outlive the session in the system's notification centre (a shared
      // reception computer): the in-app toasts go with an identity change (AuthProvider), these go here.
      closeBrowserNotifications()
    },
    [],
  )

  return null
}
