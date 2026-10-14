import { currentLanguage, i18n, type Language } from '../i18n'
import type { DateInput } from './datetime'

/**
 * "1h 37m", "45m", "2h", "< 1m" · "1 س 37 د", "45 د", "2 س", "< 1 د". Minutes are
 * truncated (a 59-second stay is "< 1m"). Hours are not rolled into days: stale visits read
 * naturally as "30h 5m". Returns "—" when the duration is unknown.
 */
export function formatDuration(totalSeconds: number | null | undefined, language: Language = currentLanguage()): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) {
    return i18n.t('duration.unknown', { lng: language })
  }
  const seconds = Math.max(0, Math.floor(totalSeconds))
  if (seconds < 60) return i18n.t('duration.lessThanMinute', { lng: language })
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours === 0) return i18n.t('duration.minutes', { lng: language, minutes })
  if (minutes === 0) return i18n.t('duration.hours', { lng: language, hours })
  return i18n.t('duration.hoursMinutes', { lng: language, hours, minutes })
}

/**
 * `formatDuration` for a duration inside a sentence: under a minute Arabic says it in words,
 * «أقل من دقيقة», since «قبل < 1 د» and «منذ < 1 د في الداخل» read as formulas (Arabic acceptance
 * run); English keeps "< 1m". Tables and figures keep `formatDuration`'s short form.
 */
export function formatDurationInText(totalSeconds: number | null | undefined, language: Language = currentLanguage()): string {
  if (typeof totalSeconds === 'number' && Number.isFinite(totalSeconds) && totalSeconds < 60) {
    return i18n.t('duration.lessThanMinuteInText', { lng: language })
  }
  return formatDuration(totalSeconds, language)
}

/** How long ago, as a phrase: "2m ago", "< 1m ago" · «قبل 2 د», «قبل أقل من دقيقة». */
export function formatAgo(totalSeconds: number, language: Language = currentLanguage()): string {
  if (!Number.isFinite(totalSeconds)) return formatDuration(null, language)
  return i18n.t('duration.ago', { lng: language, duration: formatDurationInText(totalSeconds, language) })
}

/** How long until, as a phrase: "in 10m", "in < 1m" · «بعد 10 د», «بعد أقل من دقيقة». */
export function formatIn(totalSeconds: number, language: Language = currentLanguage()): string {
  if (!Number.isFinite(totalSeconds)) return formatDuration(null, language)
  return i18n.t('duration.in', { lng: language, duration: formatDurationInText(totalSeconds, language) })
}

/**
 * How long to wait, in words, for a sentence that says when to try again ("Try again in
 * {{duration}}." / «حاول مجددًا بعد {{duration}}.»): "25 minutes", "1 hour", "1 hour 5 minutes" ·
 * «25 دقيقة», «ساعة واحدة», «ساعتين و5 دقائق» (the Arabic forms are those after «بعد»). Rounded up to
 * a whole minute, never less than one: a wait must not be over-promised short.
 */
export function formatWaitDuration(totalSeconds: number, language: Language = currentLanguage()): string {
  const totalMinutes = Number.isFinite(totalSeconds) ? Math.max(1, Math.ceil(totalSeconds / 60)) : 1
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  const minutesText = i18n.t('duration.waitMinutes', { lng: language, count: minutes })
  if (hours === 0) return minutesText
  const hoursText = i18n.t('duration.waitHours', { lng: language, count: hours })
  return minutes === 0 ? hoursText : i18n.t('duration.waitHoursMinutes', { lng: language, hours: hoursText, minutes: minutesText })
}

/** Whole seconds from `start` to `end` (never negative), e.g. for "inside for" timers. */
export function secondsBetween(start: DateInput, end: DateInput): number {
  const startMs = start instanceof Date ? start.getTime() : typeof start === 'number' ? start : Date.parse(start)
  const endMs = end instanceof Date ? end.getTime() : typeof end === 'number' ? end : Date.parse(end)
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return 0
  return Math.max(0, Math.floor((endMs - startMs) / 1000))
}
