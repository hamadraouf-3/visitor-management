import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { insideVisit, RECEPTION_NOW } from './testing/receptionFixtures'
import { VisitFacts } from './VisitFacts'

const ZONE = 'Asia/Amman'
const NOW = RECEPTION_NOW.getTime()

/** The cell (term and description) of a fact. */
function cell(term: string): HTMLElement {
  const found = screen.getAllByRole('term').find((element) => element.textContent === term)?.parentElement
  if (!found) throw new Error(`No fact ${term}`)
  return found
}

/** Whether a fact takes a whole row of the two-column grid. */
function span(term: string): boolean {
  return cell(term).classList.contains('sm:col-span-2')
}

/** The terms of the fact list, in order. */
function terms(): string[] {
  return screen.getAllByRole('term').map((term) => term.textContent ?? '')
}

describe('VisitFacts: why the visitor was let in (B57-64)', () => {
  it('shows a walk-in’s note under its reason, as written', () => {
    render(
      <VisitFacts
        visit={insideVisit({ check_in_method: 'WALK_IN', is_walk_in: true, walk_in_reason: 'OTHER', check_in_note: 'Courier\nfor Legal' })}
        timeZone={ZONE}
        now={NOW}
      />,
    )
    expect(terms()).toEqual(['Company', 'Host', 'Scheduled', 'Department', 'Purpose', 'Walk-in', 'Note', 'Checked in'])
    expect(screen.getByText('Other')).toBeInTheDocument()
    const note = screen.getByText((_, element) => element?.textContent === 'Courier\nfor Legal' && element.tagName === 'SPAN')
    expect(note).toHaveClass('whitespace-pre-wrap')
  })

  it('shows the reason given for an override after the check-in', () => {
    render(<VisitFacts visit={insideVisit({ check_in_method: 'OVERRIDE', check_in_note: 'Arrived late – host confirmed' })} timeZone={ZONE} now={NOW} />)
    expect(terms().slice(-2)).toEqual(['Checked in', 'Reason given'])
    expect(screen.getByText('Arrived late – host confirmed')).toBeInTheDocument()
    expect(screen.getByText('09:02 · 8m inside')).toBeInTheDocument()
  })

  it('leaves the note out when there is none', () => {
    render(<VisitFacts visit={insideVisit({ check_in_note: '  ' })} timeZone={ZONE} now={NOW} />)
    expect(terms()).not.toContain('Note')
    expect(terms()).not.toContain('Reason given')
  })

  it('fills every row of the two-column grid: free text and a fact left alone take the whole row', () => {
    render(<VisitFacts visit={insideVisit()} timeZone={ZONE} now={NOW} showCompany={false} />)
    // Host | Scheduled, then Department alone before the purpose, the purpose, and Checked in last.
    expect(terms()).toEqual(['Host', 'Scheduled', 'Department', 'Purpose', 'Checked in'])
    expect([span('Host'), span('Scheduled'), span('Department'), span('Purpose'), span('Checked in')]).toEqual([false, false, true, true, true])
  })

  it('leaves the company out where the visitor’s name shows it, and draws the cells on a dialog’s surface when asked', () => {
    render(<VisitFacts visit={insideVisit()} timeZone={ZONE} now={NOW} showCompany={false} surface="raised" />)
    expect(terms()).not.toContain('Company')
    expect(cell('Host')).toHaveClass('bg-surface-raised')
  })
})
