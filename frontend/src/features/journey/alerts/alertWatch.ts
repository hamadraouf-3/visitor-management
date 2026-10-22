import type { TrackingAlertSummary } from '../../../types/api'
import type { AlertBrief } from '../types'

/*
 * What the shell's watcher tells of (Phase 16), the pure part. An open alert is told of once a browser
 * session: when its id is new, and again when it is escalated (its type becomes «منطقة مقيّدة» / "Restricted
 * area": the server opens it again and e-mails again). The first answer after the shell starts only sets the
 * badge: those alerts were there before, and a reload must not ring for each of them again.
 *
 * The summary names at most 5 open alerts, the newest opened or escalated first: by `escalated_at ?? opened_at`
 * (B16-26), the brief's `sortKey` here. When more were open at the first answer, the others were never seen: each
 * would look new once it moves up into those 5 (a newer one acknowledged or resolved). The first answer's last
 * sort key is then a cut-off, since every alert it left out sorts before it: an alert sorting before it, and not
 * seen before, was there at the start and is taken in without a word. An escalation is still told of: it sorts by
 * when it escalated, after the cut-off, also for an alert the first answer left out; and the escalation of one
 * seen before is told of whatever its key (F16-38).
 */

/** An open alert as told of: by id and type. */
export function alertKey(brief: Pick<AlertBrief, 'id' | 'type'>): string {
  return `${brief.id}:${brief.type}`
}

/** The summary's order (B16-26): when the alert escalated, else when it opened. */
function sortKey(brief: Pick<AlertBrief, 'opened_at' | 'escalated_at'>): string {
  return brief.escalated_at ?? brief.opened_at
}

export interface WatchStep {
  /** Open alerts not told of before, newest first (the summary's order). */
  fresh: AlertBrief[]
  /** Every key told of (or present at the start) so far. */
  seen: ReadonlySet<string>
  /**
   * The first answer's last sort key when it could not name every open alert (null when it named them all): an
   * alert sorting before it and not seen was already open then.
   */
  cutoff: string | null
}

/** Seen before as an unauthorized-area alert: escalated since. */
function escalated(seen: ReadonlySet<string>, brief: AlertBrief): boolean {
  return brief.type === 'RESTRICTED_AREA' && seen.has(alertKey({ id: brief.id, type: 'UNAUTHORIZED_AREA' }))
}

/** `previous` null: the first answer since the shell started (nothing is fresh). */
export function watchSummary(summary: TrackingAlertSummary, previous: Pick<WatchStep, 'seen' | 'cutoff'> | null): WatchStep {
  const keys = summary.latest.map(alertKey)
  if (previous === null) {
    const last = summary.latest.at(-1)
    const cutoff = summary.open > summary.latest.length && last !== undefined ? sortKey(last) : null
    return { fresh: [], seen: new Set(keys), cutoff }
  }
  const { seen, cutoff } = previous
  const unseen = summary.latest.filter((brief) => !seen.has(alertKey(brief)))
  // Instants of the API are compared as instants (the server's offsets may differ in form).
  const before = (brief: AlertBrief) => cutoff !== null && Date.parse(sortKey(brief)) < Date.parse(cutoff)
  const fresh = unseen.filter((brief) => !before(brief) || escalated(seen, brief))
  return { fresh, seen: unseen.length === 0 ? seen : new Set([...seen, ...keys]), cutoff }
}

/** "(2) " before the page's title while alerts are open; nothing otherwise. Latin digits, as every figure of the app. */
export function alertTitlePrefix(open: number): string {
  return open > 0 ? `(${open}) ` : ''
}
