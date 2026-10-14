import { render, screen, within } from '@testing-library/react'
import { CalendarClock, MailX, Users } from 'lucide-react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { i18n } from '../../i18n'
import { Avatar } from './Avatar'
import { Card } from './Card'
import { CellStack } from './CellStack'
import { CountBadge } from './CountBadge'
import { EmptyState } from './EmptyState'
import { IconTile } from './IconTile'
import { ListRow, RowList } from './ListRow'
import { LiveIndicator } from './LiveIndicator'
import { MetaLine } from './MetaLine'
import { SectionHeader } from './SectionHeader'
import { StatMeter } from './StatMeter'
import { StatGrid, StatTile } from './StatTile'
import { StatusFilter } from './StatusFilter'
import { Table } from './Table'

/*
 * The direction C pieces the feature screens build on (brand pass, F10-31): avatars, icon tiles,
 * counts, two-line cells, list rows, section headers, KPI tiles with meters and a live dot, meta
 * lines, highlighted table rows and dark emphasis panels.
 */

describe('Avatar', () => {
  it('shows the initials, decoratively, in the chosen tone and size', () => {
    const { container } = render(<Avatar name="Omar Khalil" tone="highlight" size="lg" />)
    const avatar = container.querySelector('[data-avatar]')
    expect(avatar).toHaveTextContent('OK')
    expect(avatar).toHaveAttribute('aria-hidden', 'true')
    expect(avatar).toHaveClass('bg-highlight', 'text-on-highlight', 'size-11')
  })

  it('keeps Arabic initials apart (no ligature into another word)', () => {
    const { container } = render(<Avatar name="ليلى الحسن" />)
    expect(container.querySelector('[data-avatar]')?.textContent).toBe('ل\u200Cح')
  })
})

describe('IconTile and CountBadge', () => {
  it('draws a decorative icon on a tone tile', () => {
    const { container } = render(<IconTile icon={MailX} tone="danger" />)
    const tile = container.firstElementChild
    expect(tile).toHaveAttribute('aria-hidden', 'true')
    expect(tile).toHaveClass('bg-danger-surface', 'text-danger-solid', 'size-9')
  })

  it('formats a count with Latin digits in Space Grotesk, in the attention yellow when asked', async () => {
    render(<CountBadge tone="attention">{1234}</CountBadge>)
    expect(screen.getByText('1,234')).toHaveClass('font-numeric', 'bg-attention', 'text-on-attention')
    await i18n.changeLanguage('ar')
    expect(screen.getByText(/^1.234$/)).toBeInTheDocument()
  })
})

describe('CellStack', () => {
  it('stacks a main line over a muted one, after a leading avatar', () => {
    render(<CellStack leading={<Avatar name="Hind Khatib" />} primary="Hind Khatib" secondary="Al Bayan Consulting" />)
    expect(screen.getByText('Hind Khatib')).toHaveClass('font-semibold', 'text-fg')
    expect(screen.getByText('Al Bayan Consulting')).toHaveClass('text-fg-muted')
  })

  it('sets a numeric main line in tabular Space Grotesk', () => {
    render(<CellStack numeric primary="10:00–12:00" secondary="Arrived 10:07" />)
    expect(screen.getByText('10:00–12:00')).toHaveClass('font-numeric', 'tabular-nums')
  })
})

describe('RowList and ListRow', () => {
  it('lists rows with an icon tile, title, detail, a trailing element and an action', () => {
    render(
      <RowList label="Needs attention">
        <ListRow
          icon={MailX}
          tone="danger"
          title="Invitation not sent"
          detail="Delivery to Khaled Zoubi failed."
          meta="Due 14:30 today"
          trailing={<span>14:30</span>}
          action={<button type="button">Resend pass</button>}
        />
        <ListRow highlighted leading={<Avatar name="Fadi Qasem" />} title="Fadi Qasem" detail="Inside since 08:52" />
      </RowList>,
    )
    const list = screen.getByRole('list', { name: 'Needs attention' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByText('Delivery to Khaled Zoubi failed.')).toBeInTheDocument()
    expect(within(rows[0]!).getByRole('button', { name: 'Resend pass' })).toBeInTheDocument()
    expect(rows[1]).toHaveClass('bg-row-highlight')
    expect(rows[0]).not.toHaveClass('bg-row-highlight')
  })
})

describe('SectionHeader', () => {
  it('names a section with a count and actions, and no description', () => {
    const { container } = render(<SectionHeader id="today" title="Today’s visits" count={14} actions={<button type="button">All</button>} />)
    const heading = screen.getByRole('heading', { level: 2, name: 'Today’s visits' })
    expect(heading).toHaveAttribute('id', 'today')
    expect(heading).toHaveClass('text-section', 'font-bold')
    expect(container.querySelector('[data-count-badge]')).toHaveTextContent('14')
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument()
    expect(container.querySelectorAll('p')).toHaveLength(0)
  })
})

describe('StatTile', () => {
  it('shows the KPI with a meter and facts at its foot, label and value in one element', () => {
    render(
      <StatGrid>
        <StatTile
          label="Expected today"
          value={14}
          icon={CalendarClock}
          tone="info"
          footer={<StatMeter segments={[{ value: 11, tone: 'strong' }, { value: 1, tone: 'attention' }, { value: 2, tone: 'muted' }]} />}
          hint="11 arrived · 1 no-show · 2 to come"
        />
      </StatGrid>,
    )
    const tile = screen.getByText('Expected today').closest('div.rounded-card')
    expect(tile).toHaveTextContent('Expected today14')
    const meter = tile?.querySelector('[data-stat-meter]')
    expect(meter).toHaveAttribute('aria-hidden', 'true')
    expect(meter?.children).toHaveLength(3)
    expect(screen.getByText('11 arrived · 1 no-show · 2 to come')).toBeInTheDocument()
  })

  it('draws the emphasis tile dark, the number in light turquoise, with a live dot beside it', () => {
    render(<StatTile label="Inside now" value={6} icon={Users} variant="emphasis" aside={<LiveIndicator label="Live" tone="highlight" />} />)
    const tile = screen.getByText('Inside now').closest('div.rounded-card')
    expect(tile).toHaveClass('bg-emphasis')
    // The dark tokens apply inside the tile (its content), not to the tile itself.
    expect(tile?.firstElementChild).toHaveClass('theme-dark')
    expect(screen.getByText('6').closest('p')).toHaveClass('text-highlight', 'font-numeric')
    expect(screen.getByText('Live')).toBeInTheDocument()
  })

  it('draws an emphasis link’s focus ring in the page’s colours, not the dark tile’s (review: 1.73:1 on the canvas)', () => {
    render(
      <MemoryRouter>
        <StatTile label="Inside now" value={6} variant="emphasis" to="/inside" />
      </MemoryRouter>,
    )
    const link = screen.getByRole('link', { name: /Inside now/ })
    // The link is what takes focus; its ring is drawn outside it, on the page: the page's focus token.
    expect(link).not.toHaveClass('theme-dark')
    expect(link).toHaveClass('bg-emphasis', 'border-emphasis')
    expect(link.querySelector('.theme-dark')).toContainElement(screen.getByText('Inside now'))
  })

  it('links the whole tile with a chevron cue', () => {
    render(
      <MemoryRouter>
        <StatTile label="Left" value={5} to="/history" />
      </MemoryRouter>,
    )
    const link = screen.getByRole('link', { name: /Left/ })
    expect(link).toHaveAttribute('href', '/history')
    expect(link.querySelector('[data-link-cue]')).not.toBeNull()
  })
})

describe('StatMeter', () => {
  it('leaves out empty segments and draws nothing for a total of zero', () => {
    const { container, rerender } = render(<StatMeter segments={[{ value: 3, tone: 'strong' }, { value: 0, tone: 'attention' }]} />)
    expect(container.querySelector('[data-stat-meter]')?.children).toHaveLength(1)
    rerender(<StatMeter segments={[{ value: 0, tone: 'strong' }]} />)
    expect(container.querySelector('[data-stat-meter]')).toBeNull()
  })
})

describe('MetaLine', () => {
  it('separates facts with decorative dots and skips empty ones', () => {
    const { container } = render(<MetaLine items={['Wed 7 Oct 2026', null, <LiveIndicator key="live" label="Updated 11:20" />]} />)
    expect(container.firstElementChild).toHaveTextContent('Wed 7 Oct 2026Updated 11:20')
    expect(container.querySelectorAll('[data-meta-item]')).toHaveLength(2)
  })

  it('never strands a dot when the facts wrap: each fact carries its dot before it, and the line clips the first one of every row (UX review L13)', () => {
    const { container } = render(<MetaLine items={['Active', <span key="slug" dir="ltr">petra-logistics-and-international-freight</span>, 'Created Tue, 13 Oct 2026']} />)
    // jsdom applies no Tailwind CSS: the classes are the contract (e2e/phase11-review.spec.ts measures the result).
    const line = container.firstElementChild!
    const row = line.firstElementChild!
    const facts = [...container.querySelectorAll('[data-meta-item]')]
    expect(facts).toHaveLength(3)
    // No separator element between the facts: nothing a wrap could leave at a row's end or start.
    expect([...row.children]).toEqual(facts)
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull()
    for (const fact of facts) expect(fact).toHaveClass('ps-6', 'before:absolute', 'before:start-2.5', 'before:rounded-full')
    // The row starts the dot's room outside the line, which clips it there (on both sides, 4 px out for focus rings).
    expect(row).toHaveClass('-ms-6', 'flex-wrap')
    expect(line).toHaveClass('overflow-x-clip', '-mx-1', 'px-1')
    // A fact with a direction of its own keeps its wrapped lines on the side the line starts from.
    expect(facts[1]!.className).toContain('[&>[dir]]:text-align-parent')
  })

  it('can stack its facts on phones, one per line without the dots', () => {
    const { container } = render(<MetaLine stackOnPhones items={['Tue, 8 Sep 2026 – Wed, 7 Oct 2026', '30 days']} />)
    expect(container.firstElementChild!.firstElementChild).toHaveClass('max-sm:flex-col', 'max-sm:ms-0')
    for (const fact of container.querySelectorAll('[data-meta-item]')) expect(fact).toHaveClass('max-sm:ps-0', 'max-sm:before:hidden')
  })
})

describe('Card', () => {
  it('shows a count beside its title and can be the dark emphasis panel', () => {
    render(
      <Card title="Needs attention" titleId="attention" count={2} variant="emphasis">
        <p>Body</p>
      </Card>,
    )
    const region = screen.getByRole('region', { name: 'Needs attention' })
    expect(region).toHaveClass('theme-dark', 'bg-emphasis')
    expect(within(region).getByRole('heading', { level: 2, name: 'Needs attention' })).toHaveClass('text-section')
    expect(region.querySelector('[data-count-badge]')).toHaveTextContent('2')
  })

  it('pads its body unless flush (a table or a list of rows that runs edge to edge)', () => {
    render(
      <>
        <Card title="Padded" titleId="padded">
          <p>Padded body</p>
        </Card>
        <Card title="Flush" titleId="flush" flush>
          <p>Flush body</p>
        </Card>
      </>,
    )
    // `bodyClassName="p-0"` could not do this: Tailwind emits px-4 after p-0, so the padding won.
    expect(screen.getByText('Padded body').parentElement).toHaveClass('px-4', 'py-4')
    expect(screen.getByText('Flush body').parentElement?.className ?? '').not.toMatch(/(^|\s)p[xy]?-\d/)
  })
})

describe('Table row highlight', () => {
  it('tints the rows a screen is about, in the table and as stacked cards', () => {
    const rows = [
      { id: 'a', name: 'Yazan Hamoud', inside: false },
      { id: 'b', name: 'Hind Khatib', inside: true },
    ]
    render(
      <Table
        caption="Today’s visits"
        rows={rows}
        getRowKey={(row) => row.id}
        isRowHighlighted={(row) => row.inside}
        columns={[{ id: 'name', header: 'Visitor', primary: true, cell: (row) => <CellStack primary={row.name} /> }]}
      />,
    )
    const [, plain, highlighted] = screen.getAllByRole('row')
    expect(highlighted).toHaveAttribute('data-highlighted', 'true')
    expect(highlighted).toHaveClass('bg-row-highlight')
    expect(highlighted?.className).not.toMatch(/bg-surface/)
    expect(plain).not.toHaveAttribute('data-highlighted')
    expect(plain).toHaveClass('max-md:bg-surface')
  })
})

describe('EmptyState', () => {
  it('is a dashed placeholder inside a page and a solid card with a larger title as the whole page', () => {
    const { container, rerender } = render(<EmptyState title="No visits today" />)
    expect(container.firstElementChild).toHaveClass('border-dashed')
    expect(screen.getByRole('heading', { level: 2, name: 'No visits today' })).toHaveClass('text-lg')

    rerender(<EmptyState headingLevel="h1" figure="404" title="Page not found" />)
    expect(container.firstElementChild).not.toHaveClass('border-dashed')
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toHaveClass('text-2xl')
    // The numeral is decorative: the title says it in words.
    expect(screen.getByText('404')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByText('404')).toHaveClass('font-numeric', 'text-kpi')
  })
})

describe('StatusFilter', () => {
  it('offers the statuses under its legend, without a note on what an empty choice means', () => {
    render(<StatusFilter statuses={['SCHEDULED', 'CHECKED_IN']} value={[]} onChange={() => {}} />)
    const group = screen.getByRole('group', { name: 'Status' })
    expect(within(group).getAllByRole('checkbox')).toHaveLength(2)
    expect(group).not.toHaveAttribute('aria-describedby')
    expect(screen.queryByText(/Showing every status/)).toBeNull()
  })
})
