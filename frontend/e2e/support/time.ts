/*
 * Company wall time (the company's IANA zone, Asia/Amman for the seed) independent of the zone of
 * the machine or the browser, as the app itself computes it.
 */

const MINUTE = 60_000

interface WallParts {
  /** YYYY-MM-DD */
  date: string
  /** HH:mm (24-hour) */
  time: string
}

function parts(instant: number, timeZone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  return Object.fromEntries(formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]))
}

export function wallParts(instant: Date | number, timeZone: string): WallParts {
  const p = parts(typeof instant === 'number' ? instant : instant.getTime(), timeZone)
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }
}

/** The company-local calendar date of an instant. */
export function localDate(instant: Date | number | string, timeZone: string): string {
  return wallParts(typeof instant === 'string' ? Date.parse(instant) : instant, timeZone).date
}

/** Offset of the zone at an instant, in ms (local wall clock minus UTC). */
function offsetAt(instant: number, timeZone: string): number {
  const p = parts(instant, timeZone)
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second))
  return asUtc - Math.floor(instant / 1000) * 1000
}

/** The instant of a company wall time (date YYYY-MM-DD, time HH:mm). */
export function wallTimeToInstant(date: string, time: string, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  const [hour, minute] = time.split(':').map(Number) as [number, number]
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  let instant = guess - offsetAt(guess, timeZone)
  instant = guess - offsetAt(instant, timeZone)
  return new Date(instant)
}

/**
 * The first start time the invite form offers (15-minute steps of company wall time) at least
 * `leadMinutes` from now: the start of a visit that is "arriving now" (its pass window, which opens
 * `grace_before` minutes earlier, already includes now).
 */
export function nextQuarterHour(timeZone: string, now = Date.now(), leadMinutes = 3): Date {
  const earliest = now + leadMinutes * MINUTE
  const { date, time } = wallParts(earliest, timeZone)
  const [hour, minute] = time.split(':').map(Number) as [number, number]
  const slot = Math.ceil((hour * 60 + minute) / 15) * 15
  if (slot < 24 * 60) return wallTimeToInstant(date, `${pad(Math.floor(slot / 60))}:${pad(slot % 60)}`, timeZone)
  // Past 23:45: the next day's 00:00.
  const nextDay = wallParts(wallTimeToInstant(date, '12:00', timeZone).getTime() + 24 * 60 * MINUTE, timeZone).date
  return wallTimeToInstant(nextDay, '00:00', timeZone)
}

const pad = (value: number) => String(value).padStart(2, '0')

export const minutes = (count: number) => count * MINUTE
