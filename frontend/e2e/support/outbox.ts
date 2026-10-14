import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { OUTBOX_DIR } from './paths.ts'
import { sleep } from './processes.ts'

/*
 * The outbox e-mail provider (contract §9) writes `<id>.json` last, after `<id>.html`, `<id>.txt` and
 * the inline images `<id>-<cid>.png`, so a message whose JSON exists is complete. Delivery runs after
 * the API response (a background task), so readers poll.
 */

/** `PLATFORM_ACTION_NOTICE`: to a company's other active administrators when the platform owner adds an administrator or sends a reset link (B11-43). */
export type EmailKind =
  | 'VISITOR_INVITATION'
  | 'VISIT_RESCHEDULED'
  | 'VISIT_CANCELLED'
  | 'HOST_ARRIVAL'
  | 'PASSWORD_RESET'
  | 'PASSWORD_CHANGED'
  | 'PLATFORM_ACTION_NOTICE'

export interface OutboxMessage {
  message_id: string
  kind: EmailKind
  to: string
  subject: string
  created_at: string
  pass_url: string | null
  reset_url: string | null
  html: string
  text: string
}

export function readOutbox(): OutboxMessage[] {
  if (!existsSync(OUTBOX_DIR)) return []
  return readdirSync(OUTBOX_DIR)
    .filter((name) => name.endsWith('.json') && !name.startsWith('.tmp-'))
    .map((name) => {
      const meta = JSON.parse(readFileSync(path.join(OUTBOX_DIR, name), 'utf8')) as Omit<OutboxMessage, 'html' | 'text'>
      const stem = path.join(OUTBOX_DIR, meta.message_id)
      return { ...meta, html: readFileSync(`${stem}.html`, 'utf8'), text: readFileSync(`${stem}.txt`, 'utf8') }
    })
    .toSorted((a, b) => a.created_at.localeCompare(b.created_at) || a.message_id.localeCompare(b.message_id))
}

export interface MessageQuery {
  kind: EmailKind
  to: string
  /** Narrows the match, e.g. to the message naming one visitor (other tests mail the same host). */
  where?: (message: OutboxMessage) => boolean
}

function matches(query: MessageQuery) {
  const to = query.to.toLowerCase()
  return (message: OutboxMessage) => message.kind === query.kind && message.to.toLowerCase() === to && (query.where?.(message) ?? true)
}

export function findMessages(query: MessageQuery): OutboxMessage[] {
  return readOutbox().filter(matches(query))
}

/** The latest message of a kind to a recipient, waiting for it to be written. */
export async function waitForMessage(query: MessageQuery, timeoutMs = 20_000): Promise<OutboxMessage> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = findMessages(query)
    if (found.length > 0) return found.at(-1)!
    if (Date.now() > deadline) throw new Error(`No ${query.kind} message to ${query.to} in the outbox after ${timeoutMs} ms`)
    await sleep(250)
  }
}

/**
 * The logo in an e-mail's header (`cid:brand-logo`, backend B10-6; since Phase 12 the company's own in every e-mail its people and visitors receive, the notice of a platform action included, and none while it has no logo: B12-12, B12-22):
 * part of the layout, not of a message's content. Since Phase 13 an opaque rendition of the logo on a white plate (B13-2).
 */
export const BRAND_LOGO_CID = 'brand-logo'

/** The logo for dark surfaces in the e-mail's dark design (Phase 13, B13-2): an opaque rendition on the dark header's colour; part of the layout too. */
export const BRAND_LOGO_DARK_CID = 'brand-logo-dark'

const LAYOUT_CIDS: readonly string[] = [BRAND_LOGO_CID, BRAND_LOGO_DARK_CID]

/** The inline images an HTML message references (`src="cid:…"`), as written by the outbox. */
function referencedImages(message: OutboxMessage): { cid: string; file: string; bytes: Buffer }[] {
  const cids = [...new Set([...message.html.matchAll(/src="cid:([A-Za-z0-9._-]{1,64})"/g)].map((match) => match[1]!))]
  return cids.map((cid) => {
    const file = path.join(OUTBOX_DIR, `${message.message_id}-${cid}.png`)
    return { cid, file, bytes: readFileSync(file) }
  })
}

/** The content images of an HTML message (an invitation's QR code), without the brand logos of the layout. */
export function inlineImages(message: OutboxMessage): { cid: string; file: string; bytes: Buffer }[] {
  return referencedImages(message).filter((image) => !LAYOUT_CIDS.includes(image.cid))
}

/** The brand logo inline image of a message, or null when it has none. */
export function brandLogoImage(message: OutboxMessage): { cid: string; file: string; bytes: Buffer } | null {
  return referencedImages(message).find((image) => image.cid === BRAND_LOGO_CID) ?? null
}

/** The rendition of the logo for dark surfaces of a message (its dark design), or null when it has none. */
export function brandLogoDarkImage(message: OutboxMessage): { cid: string; file: string; bytes: Buffer } | null {
  return referencedImages(message).find((image) => image.cid === BRAND_LOGO_DARK_CID) ?? null
}

/**
 * What a PNG's header says (its IHDR) and whether it can be see-through: a colour type with alpha, or a
 * `tRNS` chunk. An e-mail's logo renditions are opaque (Phase 13, B13-2).
 */
export function pngFacts(bytes: Buffer): { width: number; height: number; colourType: number; seeThrough: boolean } {
  const colourType = bytes[25]!
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colourType, seeThrough: colourType === 4 || colourType === 6 || bytes.includes(Buffer.from('tRNS')) }
}
