import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { dateRangeFact, dateRangeReadBack } from '../../utils/dateRange'
import { DateRangeFields } from './DateRangeFields'
import { DateTimeField } from './DateTimeField'

describe('dateRangeReadBack', () => {
  it('reads the chosen dates in the app’s format, whatever the browser shows in the inputs', () => {
    expect(dateRangeReadBack('2026-10-05', '2026-10-11')).toBe('From Mon, 5 Oct 2026 to Sun, 11 Oct 2026.')
    expect(dateRangeReadBack('2026-10-05', '2026-10-05')).toBe('On Mon, 5 Oct 2026.')
    expect(dateRangeReadBack('2026-10-05', null)).toBe('From Mon, 5 Oct 2026.')
    expect(dateRangeReadBack(null, '2026-10-11')).toBe('Up to Sun, 11 Oct 2026.')
    expect(dateRangeReadBack(null, null)).toBeNull()
  })

  it('gives the same as a fact for a header’s line of facts, without the full stop', () => {
    expect(dateRangeFact('2026-10-05', '2026-10-11')).toBe('From Mon, 5 Oct 2026 to Sun, 11 Oct 2026')
    // Each date's day, month and year on one line (no-break spaces).
    expect(dateRangeFact('2026-10-05', '2026-10-11', 'ar')?.replaceAll('\u00a0', ' ')).toBe('من الاثنين، 5 تشرين الأول 2026 إلى الأحد، 11 تشرين الأول 2026')
    expect(dateRangeFact(null, null)).toBeNull()
  })
})

describe('DateRangeFields', () => {
  it('names the group for assistive technology only, with "From" and "To" as the visible labels', () => {
    render(<DateRangeFields legend="Date" from={null} to={null} onChange={() => {}} />)
    const group = screen.getByRole('group', { name: 'Date' })
    // Level with the other labels of a filter row: no visible legend above "From" and "To".
    expect(group.querySelector('legend')).toHaveClass('sr-only')
    expect(screen.getByLabelText('From')).toHaveAttribute('type', 'date')
    expect(screen.getByLabelText('To')).toHaveAttribute('type', 'date')
  })

  it('describes the group with the read-back of the chosen dates (the screen shows it in its header), and no time-zone note', () => {
    render(<DateRangeFields legend="Date" from="2026-10-05" to="2026-10-11" onChange={() => {}} />)
    expect(screen.getByRole('group', { name: 'Date' })).toHaveAccessibleDescription('From Mon, 5 Oct 2026 to Sun, 11 Oct 2026.')
    expect(screen.getByText('From Mon, 5 Oct 2026 to Sun, 11 Oct 2026.')).toHaveClass('sr-only')
    expect(screen.queryByText(/Days follow/)).toBeNull()
  })

  it('shows nothing under the dates before any is chosen', () => {
    render(<DateRangeFields legend="Date" from={null} to={null} onChange={() => {}} />)
    expect(screen.getByRole('group', { name: 'Date' })).not.toHaveAttribute('aria-describedby')
  })

  it('keeps each date input at least 10.5rem wide (an empty placeholder clears the calendar button) and wraps when two do not fit', () => {
    const { container } = render(<DateRangeFields legend="Date" from={null} to={null} onChange={() => {}} />)
    // jsdom has no layout: the grid's track rule is the contract (auto-fill wraps "To" under "From").
    const grid = container.querySelector('[data-date-range-grid]')
    expect(grid).toHaveClass('grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))]')
    expect(grid?.className).not.toMatch(/minmax\(0,/)
  })
})

describe('DateTimeField read-back', () => {
  it('reads the chosen moment back in the app’s format in the controls’ description', () => {
    render(<DateTimeField label="Expected end" value="2026-10-06T07:10:00.000Z" onChange={() => {}} timeZone="Asia/Amman" showTimeZone={false} readBack />)
    expect(screen.getByLabelText('Expected end date')).toHaveAccessibleDescription('Tue, 6 Oct 2026, 10:10')
  })
})
