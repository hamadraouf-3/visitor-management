import { findMatch } from '../../utils/highlight'

/**
 * `text` with the part matching `query` (case- and accent-insensitive) in bold. Not underlined:
 * in an option list an underline reads as a link. A plain span, not `<mark>`: screen readers
 * would announce "highlighted" inside every option.
 */
export function HighlightMatch({ text, query }: { text: string; query: string }) {
  const match = findMatch(text, query)
  if (!match) return <>{text}</>
  const [start, end] = match
  return (
    <>
      {text.slice(0, start)}
      <span data-match="" className="font-semibold text-fg">
        {text.slice(start, end)}
      </span>
      {text.slice(end)}
    </>
  )
}
