import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { i18n } from '../../i18n'
import { TopHosts } from './TopHosts'

const HOSTS = [
  { host_id: 'h-1', full_name: 'Omar Khalil', count: 40 },
  { host_id: 'h-2', full_name: 'Lina Haddad', count: 10 },
]

/** The drawn start and length of each host's bar (its fill rect), as percentages of the track. */
function bars() {
  return [...document.querySelectorAll('svg[data-host-bar] rect:last-child')].map((rect) => [rect.getAttribute('x'), rect.getAttribute('width')])
}

describe('TopHosts', () => {
  it('grows each bar from the reading start: the left in English, the right in Arabic', async () => {
    await i18n.changeLanguage('en')
    const english = render(<TopHosts hosts={HOSTS} total={100} />)
    expect(bars()).toEqual([
      ['0', '100%'],
      ['0', '25%'],
    ])
    english.unmount()

    await i18n.changeLanguage('ar')
    render(<TopHosts hosts={HOSTS} total={100} />)
    expect(bars()).toEqual([
      ['0%', '100%'],
      ['75%', '25%'],
    ])
    // The columns read in Arabic; the numbers keep Latin digits.
    const table = screen.getByRole('table', { name: 'أكثر المضيفين استقبالًا' })
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['م', 'المضيف', 'الزيارات', 'النسبة'])
    expect(within(within(table).getAllByRole('row')[2]!).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['2', '10', '10.0%'])
  })

  it('says so when no host had visits, without a table', async () => {
    await i18n.changeLanguage('en')
    render(<TopHosts hosts={[]} total={0} />)
    expect(screen.getByText('No hosted visits in this period.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })
})
