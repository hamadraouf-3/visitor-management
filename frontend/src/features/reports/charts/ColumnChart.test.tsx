import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { i18n } from '../../../i18n'
import type { ChartDatum } from '../chartData'
import { ColumnChart } from './ColumnChart'

const DATA: ChartDatum[] = [
  { key: 'a', axisLabel: 'A', label: 'First day', value: 2 },
  { key: 'b', axisLabel: 'B', label: 'Second day', value: 5 },
  { key: 'c', axisLabel: 'C', label: 'Third day', value: 3 },
]

function renderChart() {
  return render(<ColumnChart data={DATA} label="Visits per day" formatValue={(value) => `${value} visits`} axisLabelWidth={8} />)
}

/** The x of an axis label, as drawn (jsdom has no layout; the chart is 640 wide there). */
function labelX(text: string): number {
  return Number(screen.getByText(text, { selector: 'text' }).getAttribute('x'))
}

/*
 * In Arabic, time runs from the right and the value axis stands on the right (direction C):
 * the drawing is laid out left to right and mirrored, its texts placed but never mirrored.
 */
describe('ColumnChart direction', () => {
  it('runs left to right in English', async () => {
    await i18n.changeLanguage('en')
    const { container } = renderChart()
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('direction', 'ltr')
    expect(labelX('A')).toBeLessThan(labelX('B'))
    expect(labelX('B')).toBeLessThan(labelX('C'))
    expect(container.querySelector('g[transform]')).toBeNull()
  })

  it('runs right to left in Arabic, the marks mirrored and the texts placed, not mirrored', async () => {
    await i18n.changeLanguage('ar')
    const { container } = renderChart()
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('direction', 'rtl')
    expect(labelX('A')).toBeGreaterThan(labelX('B'))
    expect(labelX('B')).toBeGreaterThan(labelX('C'))
    // The first day sits in the right half; the marks and hit targets flip around the width.
    expect(labelX('A')).toBeGreaterThan(320)
    const mirrored = [...container.querySelectorAll('g[transform]')].map((group) => group.getAttribute('transform'))
    expect(mirrored).toEqual(['matrix(-1 0 0 1 640 0)', 'matrix(-1 0 0 1 640 0)'])
    // No text sits inside a mirrored group (it would read backwards).
    for (const group of container.querySelectorAll('g[transform]')) expect(group.querySelector('text')).toBeNull()
  })

  it('moves the keyboard cursor with the arrow that points the way time runs', async () => {
    await i18n.changeLanguage('ar')
    renderChart()
    const user = userEvent.setup()
    // The peak (the second day) is the tab stop.
    await user.tab()
    expect(screen.getByRole('img', { name: 'Second day: 5 visits' })).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(screen.getByRole('img', { name: 'Third day: 3 visits' })).toHaveFocus()
    await user.keyboard('{ArrowRight}{ArrowRight}')
    expect(screen.getByRole('img', { name: 'First day: 2 visits' })).toHaveFocus()

    await i18n.changeLanguage('en')
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('img', { name: 'Second day: 5 visits' })).toHaveFocus()
  })
})
