import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { i18n } from '../../../i18n'
import type { ChartDatum } from '../chartData'
import { BarChart } from './BarChart'

const DATA: ChartDatum[] = [
  { key: 'a', axisLabel: 'Sales', label: 'Sales', value: 8 },
  { key: 'b', axisLabel: 'Legal', label: 'Legal', value: 3 },
]

/** The x of a drawn value label (jsdom has no layout; the chart is drawn 640 wide there). */
function valueX(container: HTMLElement, value: string): number {
  const text = [...container.querySelectorAll('text')].find((node) => node.textContent === value)
  return Number(text?.getAttribute('x'))
}

describe('BarChart direction', () => {
  it('grows its bars from the reading start: the left in English, the right in Arabic', async () => {
    await i18n.changeLanguage('en')
    const english = render(<BarChart data={DATA} label="Visits by department" formatValue={(value) => `${value} visits`} />)
    expect(english.container.querySelector('svg')).toHaveAttribute('direction', 'ltr')
    expect(english.container.querySelector('path[transform]')).toBeNull()
    // The longer bar's value sits further from the start.
    expect(valueX(english.container, '8')).toBeGreaterThan(valueX(english.container, '3'))
    english.unmount()

    await i18n.changeLanguage('ar')
    const arabic = render(<BarChart data={DATA} label="Visits by department" formatValue={(value) => `${value} visits`} />)
    expect(arabic.container.querySelector('svg')).toHaveAttribute('direction', 'rtl')
    for (const bar of arabic.container.querySelectorAll('path[transform]')) expect(bar).toHaveAttribute('transform', 'matrix(-1 0 0 1 640 0)')
    expect(arabic.container.querySelectorAll('path[transform]')).toHaveLength(2)
    expect(valueX(arabic.container, '8')).toBeLessThan(valueX(arabic.container, '3'))
  })
})
