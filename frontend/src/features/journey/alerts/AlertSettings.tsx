import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../../components/ui/Badge'
import { Switch } from '../../../components/ui/Switch'
import { useStableId } from '../../../hooks/useStableId'
import { notificationSupport, requestNotificationPermission, useAlertPreferences, type NotificationSupport } from './alertPreferences'

/**
 * The viewer's own alert settings on this device (Phase 16): «صوت التنبيه» / "Alert sound" and «إشعارات
 * المتصفح» / "Browser notifications", switches that take effect at once. Notifications ask the browser's
 * permission when turned on; where the browser blocks or lacks them the switch stays off, disabled, with
 * the short state beside it.
 */
export function AlertSettings({ userId }: { userId: string }) {
  const { t } = useTranslation('journey')
  const [preferences, setPreference] = useAlertPreferences(userId)
  const [support, setSupport] = useState<NotificationSupport>(() => notificationSupport())
  const [asking, setAsking] = useState(false)
  const stateId = useStableId('notifications-state')
  const blocked = support === 'denied' || support === 'unsupported'

  const toggleNotifications = async (next: boolean) => {
    if (!next) {
      setPreference('notifications', false)
      return
    }
    setAsking(true)
    const answer = support === 'granted' ? 'granted' : await requestNotificationPermission()
    setAsking(false)
    setSupport(answer)
    setPreference('notifications', answer === 'granted')
  }

  return (
    <section aria-label={t('alerts.settings')} data-alert-settings="" className="flex flex-wrap items-center gap-x-6 gap-y-2">
      <Switch label={t('alerts.sound')} checked={preferences.sound} onCheckedChange={(next) => setPreference('sound', next)} />
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Switch
          label={t('alerts.notifications')}
          checked={preferences.notifications && support === 'granted'}
          disabled={blocked}
          loading={asking}
          aria-describedby={blocked ? stateId : undefined}
          onCheckedChange={(next) => void toggleNotifications(next)}
        />
        {blocked && (
          <span id={stateId}>
            <Badge tone="neutral">{support === 'denied' ? t('alerts.notificationsBlocked') : t('alerts.notificationsUnsupported')}</Badge>
          </span>
        )}
      </span>
    </section>
  )
}
