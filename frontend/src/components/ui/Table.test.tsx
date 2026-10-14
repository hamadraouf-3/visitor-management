import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EmptyState } from './EmptyState'
import { Table, type TableColumn } from './Table'
import { tableRowLinkProps } from './tableStyles'

interface Row {
  id: string
  visitor: string
  host: string
}

const columns: TableColumn<Row>[] = [
  { id: 'visitor', header: 'Visitor', primary: true, cell: (row) => row.visitor },
  { id: 'host', header: 'Host', cell: (row) => row.host },
  { id: 'actions', header: 'Actions', headerHidden: true, align: 'end', cell: () => <button type="button">Check out</button> },
]

const rows: Row[] = [
  { id: '1', visitor: 'Élodie Martin', host: 'Lina Haddad' },
  { id: '2', visitor: 'Omar Khalil', host: 'Rana Saleh' },
]

describe('Table', () => {
  it('renders a captioned table with column headers', () => {
    render(<Table caption="Visitors inside" columns={columns} rows={rows} getRowKey={(row) => row.id} />)

    const table = screen.getByRole('table', { name: 'Visitors inside' })
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Visitor', 'Host', 'Actions'])
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    const firstRow = within(table).getAllByRole('row')[1] as HTMLElement
    expect(within(firstRow).getAllByRole('cell')[0]).toHaveTextContent('Élodie Martin')
  })

  it('keeps table semantics when the small-screen card layout changes display', () => {
    const { container } = render(<Table caption="Visitors inside" columns={columns} rows={rows} getRowKey={(row) => row.id} />)

    // WebKit drops implicit table roles once display is block/flex, so they are explicit.
    const roleOf = (selector: string) => [...container.querySelectorAll(selector)].map((element) => element.getAttribute('role'))
    expect(roleOf('table')).toEqual(['table'])
    expect(roleOf('thead, tbody')).toEqual(['rowgroup', 'rowgroup'])
    expect(new Set(roleOf('tr'))).toEqual(new Set(['row']))
    expect(new Set(roleOf('th'))).toEqual(new Set(['columnheader']))
    expect(new Set(roleOf('td'))).toEqual(new Set(['cell']))

    // Below md the header row is visually hidden, never display:none, so headers stay in the
    // accessibility tree (jsdom applies no Tailwind CSS, so the utility classes are the contract).
    const thead = container.querySelector('thead') as HTMLElement
    expect(thead.className).toContain('max-md:sr-only')
    expect(thead.className).not.toMatch(/(^|\s)max-md:hidden(\s|$)/)
  })

  it('shows small-screen labels as real text hidden from assistive technology', () => {
    render(<Table caption="Visitors inside" columns={columns} rows={rows} getRowKey={(row) => row.id} />)

    const firstRow = screen.getAllByRole('row')[1] as HTMLElement
    const [visitorCell, hostCell, actionsCell] = within(firstRow).getAllByRole('cell') as [HTMLElement, HTMLElement, HTMLElement]
    const hostLabel = within(hostCell).getByText('Host')
    expect(hostLabel).toHaveAttribute('aria-hidden', 'true')
    expect(hostLabel.className).toContain('md:hidden')
    expect(hostCell).toHaveTextContent('Lina Haddad')
    // The primary column is the card title and the actions column has no visible header: no label.
    expect(within(visitorCell).queryByText('Visitor')).toBeNull()
    expect(within(actionsCell).queryByText('Actions')).toBeNull()
    expect(within(actionsCell).getByRole('button', { name: 'Check out' })).toBeInTheDocument()
  })

  it('can stack below lg, show cells inline or leave them out of the card, and fix column widths', () => {
    const compact: TableColumn<Row>[] = [
      { id: 'visitor', header: 'Visitor', primary: true, cell: (row) => row.visitor, headerClassName: 'lg:w-1/2' },
      { id: 'status', header: 'Status', stacked: 'inline', cell: () => 'Scheduled' },
      { id: 'host', header: 'Host', stacked: 'hidden', cell: (row) => row.host },
    ]
    const { container } = render(
      <Table caption="Visits" columns={compact} rows={rows} getRowKey={(row) => row.id} stackBelow="lg" layout="fixed" />,
    )

    const table = screen.getByRole('table', { name: 'Visits' })
    expect(table.className).toContain('lg:table-fixed')
    expect((container.querySelector('thead') as HTMLElement).className).toContain('max-lg:sr-only')
    expect(within(table).getAllByRole('columnheader')[0]!.className).toContain('lg:w-1/2')
    const [, statusCell, hostCell] = within(within(table).getAllByRole('row')[1] as HTMLElement).getAllByRole('cell') as HTMLElement[]
    // Inline cells carry no label; hidden ones are left out of the card only (and need none).
    expect(statusCell!.className).toContain('max-lg:inline-flex')
    expect(within(statusCell!).queryByText('Status')).toBeNull()
    expect(hostCell!.className).toContain('max-lg:hidden')
    expect(hostCell).toHaveTextContent('Lina Haddad')
    expect(within(hostCell!).queryByText('Host')).toBeNull()
  })

  it('can fix column widths from xl only, leaving narrower desktops to the content', () => {
    render(<Table caption="Visits" columns={columns} rows={rows} getRowKey={(row) => row.id} stackBelow="lg" layout="fixed-xl" />)
    const table = screen.getByRole('table', { name: 'Visits' })
    expect(table.className).toContain('xl:table-fixed')
    expect(table.className).not.toContain('lg:table-fixed')
  })

  it('lines each stacked value up at the start beside its label, and leaves empty values out of the card', () => {
    interface Visitor {
      id: string
      name: string
      lastCheckIn: string | null
      total: number
    }
    const visitorColumns: TableColumn<Visitor>[] = [
      { id: 'name', header: 'Visitor', primary: true, cell: (row) => row.name },
      { id: 'last', header: 'Last check-in', isEmpty: (row) => row.lastCheckIn === null, cell: (row) => row.lastCheckIn ?? '—' },
      { id: 'total', header: 'All visits', align: 'end', cell: (row) => row.total },
    ]
    render(
      <Table
        caption="Visitors"
        columns={visitorColumns}
        rows={[
          { id: '1', name: 'Élodie Martin', lastCheckIn: 'Sun, 20 Sep 2026', total: 3 },
          { id: '2', name: 'Omar Khalil', lastCheckIn: null, total: 0 },
        ]}
        getRowKey={(row) => row.id}
      />,
    )

    const [, first, second] = screen.getAllByRole('row') as HTMLElement[]
    const [, lastCell, totalCell] = within(first!).getAllByRole('cell') as HTMLElement[]
    // Label and value form a two-column line; nothing pushes the value to the far edge.
    expect(lastCell!.className).toContain('max-md:grid')
    expect(lastCell!.className).toContain('max-md:grid-cols-[minmax(6rem,8rem)_minmax(0,1fr)]')
    expect(lastCell!.className).not.toMatch(/justify-between|text-right|text-end/)
    // An end-aligned column is aligned to the end (right in English, left in Arabic) in the table
    // only, not in the card; never with a physical side.
    expect(totalCell!.className).toContain('md:text-end')
    expect(totalCell!.className).not.toMatch(/(^|\s)(max-md:)?text-end(\s|$)/)
    expect(totalCell!.className).not.toMatch(/text-right|text-left/)
    // The value is one grid item next to its label.
    expect(lastCell!.children).toHaveLength(2)
    expect(lastCell!.lastElementChild).toHaveTextContent('Sun, 20 Sep 2026')

    // No "Last check-in —" line in the card of a visitor who never checked in; the table still shows "—".
    const emptyCell = within(second!).getAllByRole('cell')[1] as HTMLElement
    expect(emptyCell.className).toContain('max-md:hidden')
    expect(emptyCell).toHaveTextContent('—')
  })

  it('leaves an empty inline cell out of the card too, so it adds no blank band', () => {
    interface Visit {
      id: string
      name: string
      flags: string[]
    }
    const visitColumns: TableColumn<Visit>[] = [
      { id: 'name', header: 'Visitor', primary: true, cell: (row) => row.name },
      {
        id: 'flags',
        header: 'Flags',
        stacked: 'inline',
        isEmpty: (row) => row.flags.length === 0,
        cell: (row) => (row.flags.length === 0 ? <span className="sr-only">None</span> : row.flags.join(', ')),
      },
    ]
    render(
      <Table
        caption="Inside"
        columns={visitColumns}
        rows={[
          { id: '1', name: 'Élodie Martin', flags: ['Overdue'] },
          { id: '2', name: 'Mei Chen', flags: [] },
        ]}
        getRowKey={(row) => row.id}
        stackBelow="lg"
      />,
    )
    const [, flagged, plain] = screen.getAllByRole('row') as HTMLElement[]
    expect(within(flagged!).getAllByRole('cell')[1]!.className).toContain('max-lg:inline-flex')
    const empty = within(plain!).getAllByRole('cell')[1] as HTMLElement
    expect(empty.className).toContain('max-lg:hidden')
    expect(empty.className).not.toContain('max-lg:inline-flex')
    // The table layout keeps the cell and its "None".
    expect(empty).toHaveTextContent('None')
  })

  it('puts the cards of a table that stacks below lg in two columns between md and lg', () => {
    const { container } = render(<Table caption="Visits" columns={columns} rows={rows} getRowKey={(row) => row.id} stackBelow="lg" />)

    const tbody = container.querySelector('tbody') as HTMLElement
    expect(tbody.className).toContain('max-md:flex-col')
    expect(tbody.className).toContain('md:max-lg:grid-cols-2')
  })

  it('stacks the widest tables below xl, two cards per row from md, with tighter cells until 2xl', () => {
    const { container } = render(<Table caption="Visits" columns={columns} rows={rows} getRowKey={(row) => row.id} stackBelow="xl" layout="fixed" />)

    const table = screen.getByRole('table', { name: 'Visits' })
    expect(table.className).toContain('max-xl:block')
    expect(table.className).toContain('xl:table-fixed')
    expect((container.querySelector('tbody') as HTMLElement).className).toContain('md:max-xl:grid-cols-2')
    expect((container.querySelector('thead') as HTMLElement).className).toContain('max-xl:sr-only')
    // Header and body cells keep the same padding, so the columns line up.
    expect(within(table).getAllByRole('columnheader')[0]!.className).toContain('2xl:px-4')
    expect(within(table).getAllByRole('cell')[0]!.className).toContain('2xl:px-4')
    expect(tableRowLinkProps('xl').className).toContain('max-xl:after:inset-0')
  })

  it('keeps visually hidden header text inside its scroll box (a positioned wrapper), so it never widens the page', () => {
    render(<Table caption="Visits" columns={columns} rows={rows} getRowKey={(row) => row.id} />)
    const wrapper = screen.getByRole('table', { name: 'Visits' }).parentElement as HTMLElement
    expect(wrapper.className).toContain('relative')
    expect(wrapper.className).toContain('md:overflow-x-auto')
  })

  it('makes the row link cover the stacked card', () => {
    expect(tableRowLinkProps().className).toContain('max-md:after:inset-0')
    expect(tableRowLinkProps('lg').className).toContain('max-lg:after:inset-0')
    expect(tableRowLinkProps()).toHaveProperty('data-row-link', '')
  })

  it('shows the empty state instead of an empty table', () => {
    render(
      <Table
        caption="Visitors inside"
        columns={columns}
        rows={[]}
        getRowKey={(row) => row.id}
        empty={<EmptyState title="Nobody is inside" />}
      />,
    )

    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Nobody is inside' })).toBeInTheDocument()
  })

  it('shows a labelled loading state on first load', () => {
    render(<Table caption="Visitors inside" columns={columns} rows={[]} getRowKey={(row) => row.id} loading />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading visitors inside…')
  })
})
