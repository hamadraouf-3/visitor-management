import { Fragment, type ReactNode } from 'react'
import { DATA_SEPARATOR } from '../../utils/text'

/**
 * Items of data in one line, " · " between them, each in its own bidirectional isolate (`<bdi>`).
 * Without the isolates, two values in the other script than the UI's (an Arabic host and an
 * Arabic department in the English UI) and the separator between them were laid out as one run in
 * that script's direction: "Host عمر خليل · العمليات" read "Host العمليات · عمر خليل", the department
 * next to "Host". Empty items are left out.
 */
export function DataLine({ items }: { items: readonly ReactNode[] }) {
  const shown = items.filter((item) => item !== null && item !== undefined && item !== false && item !== '')
  return (
    <>
      {shown.map((item, index) => (
        <Fragment key={index}>
          {index > 0 && DATA_SEPARATOR}
          <bdi>{item}</bdi>
        </Fragment>
      ))}
    </>
  )
}
