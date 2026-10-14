/** Sample contract types for the comparator's own tests (`contractParity.test.ts`). */

export type Colour = 'RED' | 'GREEN'

export interface Item {
  id: string
  colour: Colour
  note: string | null
  count: number
  tags: string[]
  flag: boolean
  extra?: number
  meta: Record<string, unknown>
  owner: { id: string; name: string }
}

export interface ItemUpdate {
  note?: string | null
  count?: number
}

export type Command = { kind: 'RENAME'; name: string } | { kind: 'ARCHIVE' }

export interface Page<T> {
  items: T[]
  total: number
}

export type ItemPage = Page<Item>

/** Deliberately looser than a backend list filter and a plain-string code. */
export interface ItemListParams {
  colour?: Colour | Colour[]
  code?: Colour | (string & {})
}
