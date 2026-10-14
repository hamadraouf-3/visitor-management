import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { readEnumParam, useUrlParams } from '../../hooks/useUrlParams'
import { renderWithProviders } from '../../test/render'
import { TabPanel, Tabs } from './Tabs'

const TAB_VALUES = ['scan', 'expected', 'inside', 'walk-in'] as const
type ReceptionTab = (typeof TAB_VALUES)[number]
const DEFAULT_TAB: ReceptionTab = 'scan'

/** The pattern screens use: the tab is read from and written to the URL (`?tab=`). */
function ReceptionTabs({ disableInside = false }: { disableInside?: boolean }) {
  const [params, updateParams] = useUrlParams()
  const tab = readEnumParam(params, 'tab', TAB_VALUES, DEFAULT_TAB)
  return (
    <>
      <Tabs
        idBase="reception"
        label="Reception"
        value={tab}
        onValueChange={(next) => updateParams({ tab: next === DEFAULT_TAB ? null : next })}
        items={[
          { value: 'scan', label: 'Scan' },
          { value: 'expected', label: 'Expected', badge: 3 },
          { value: 'inside', label: 'Inside', disabled: disableInside },
          { value: 'walk-in', label: 'Walk-in', badge: 1, badgeTone: 'warning' },
        ]}
      />
      {TAB_VALUES.map((value) => (
        <TabPanel key={value} idBase="reception" value={value} selected={tab}>
          {value} panel
        </TabPanel>
      ))}
    </>
  )
}

function getTab(name: string | RegExp) {
  return screen.getByRole('tab', { name })
}

describe('Tabs', () => {
  it('exposes tablist semantics with one tabbable, selected tab and a labelled panel', () => {
    renderWithProviders(<ReceptionTabs />, { initialEntries: ['/reception'] })

    expect(screen.getByRole('tablist', { name: 'Reception' })).toBeInTheDocument()
    expect(getTab('Scan')).toHaveAttribute('aria-selected', 'true')
    expect(getTab('Scan')).toHaveAttribute('tabindex', '0')
    expect(getTab(/Expected/)).toHaveAttribute('tabindex', '-1')
    expect(screen.getByRole('tabpanel', { name: 'Scan' })).toHaveTextContent('scan panel')
    expect(screen.queryByText('expected panel')).toBeNull()
  })

  it('moves and selects with arrow keys, wrapping at both ends, and Home/End', async () => {
    const { user } = renderWithProviders(<ReceptionTabs />, { initialEntries: ['/reception'] })
    await user.click(getTab('Scan'))

    await user.keyboard('{ArrowRight}')
    expect(getTab(/Expected/)).toHaveFocus()
    expect(getTab(/Expected/)).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('expected panel')

    await user.keyboard('{End}')
    expect(getTab(/Walk-in/)).toHaveFocus()

    await user.keyboard('{ArrowRight}')
    expect(getTab('Scan')).toHaveFocus()
    expect(getTab('Scan')).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{ArrowLeft}')
    expect(getTab(/Walk-in/)).toHaveFocus()

    await user.keyboard('{Home}')
    expect(getTab('Scan')).toHaveFocus()
  })

  it('skips disabled tabs', async () => {
    const { user } = renderWithProviders(<ReceptionTabs disableInside />, { initialEntries: ['/reception?tab=expected'] })
    await user.click(getTab(/Expected/))

    await user.keyboard('{ArrowRight}')

    expect(getTab(/Walk-in/)).toHaveFocus()
  })

  it('keeps the selected tab in the URL; the default tab is omitted', async () => {
    const { user, router } = renderWithProviders(<ReceptionTabs />, { initialEntries: ['/reception?tab=inside&page=2'] })

    expect(getTab('Inside')).toHaveAttribute('aria-selected', 'true')

    await user.click(getTab(/Walk-in/))
    expect(router.state.location.search).toBe('?tab=walk-in&page=2')

    await user.click(getTab('Scan'))
    expect(router.state.location.search).toBe('?page=2')
  })

  it('falls back to the default tab for unknown URL values', () => {
    renderWithProviders(<ReceptionTabs />, { initialEntries: ['/reception?tab=bogus'] })
    expect(getTab('Scan')).toHaveAttribute('aria-selected', 'true')
  })

  it('shows badges after the label, a warning badge in its own tone', () => {
    renderWithProviders(<ReceptionTabs />, { initialEntries: ['/reception'] })

    expect(getTab('Expected 3')).toBeInTheDocument()
    expect(getTab(/Walk-in/).querySelector('span')?.className).toContain('bg-attention')
  })

  it('can lay the tabs out two per row on phones instead of scrolling, marking the selected one by its border', () => {
    renderWithProviders(
      <Tabs
        idBase="visits"
        label="Visits"
        value="today"
        onValueChange={() => {}}
        phoneLayout="grid"
        items={[
          { value: 'today', label: 'Today', badge: 2 },
          { value: 'attention', label: 'Needs attention', badge: 1 },
        ]}
      />,
    )

    // jsdom applies no Tailwind CSS, so the classes are the contract.
    const list = screen.getByRole('tablist', { name: 'Visits' })
    expect(list.className).toContain('max-sm:grid-cols-2')
    expect(list.className).toContain('max-sm:overflow-visible')
    // No scroll shadows on the bare page (their cover drew bands at the edges).
    expect(list.className).toContain('max-sm:bg-none')
    expect(getTab('Today 2').className).toContain('max-sm:border-2')
    expect(getTab('Needs attention 1').className).toContain('max-sm:border-border-strong')
    expect(getTab('Needs attention 1').className).not.toContain('max-sm:border-2')
    // The selected segment keeps its raised fill on phones (on a dark surface the surface colour would
    // leave its ink label at about 1.1:1), and its ring, outside it there, takes the focus colour.
    expect(getTab('Today 2').className).toContain('bg-tab-selected')
    expect(getTab('Today 2').className).not.toContain('max-sm:bg-surface')
    expect(getTab('Today 2').className).toContain('max-sm:focus-visible:outline-focus')
    expect(getTab('Needs attention 1').className).toContain('max-sm:bg-surface')
    // From sm the grid is a segmented control again, its selected segment edged in teal.
    expect(getTab('Today 2').className).toContain('sm:ring-tab-indicator')
    expect(getTab('Today 2').className).not.toMatch(/(^|\s)ring-1(\s|$)/)
    // The phone grid spans the width; the segmented control hugs its segments from sm.
    const track = list.parentElement
    expect(track?.className).toContain('w-fit')
    expect(track?.className).toContain('max-sm:w-full')
  })

  it('edges the selected segment with the teal indicator, so the selection does not rest on white against the track (WCAG 1.4.11)', () => {
    renderWithProviders(<ReceptionTabs />, { initialEntries: ['/reception'] })

    // jsdom applies no Tailwind CSS, so the classes are the contract: --color-tab-indicator is
    // the side-nav teal on light surfaces (4.70:1 against the white segment, 3.85:1 against the track).
    expect(getTab('Scan').className).toMatch(/(^|\s)ring-1(\s|$)/)
    expect(getTab('Scan').className).toContain('ring-tab-indicator')
    expect(getTab(/Expected/).className).not.toContain('ring-tab-indicator')
  })

  it('sizes the track to its segments (never wider than its container) instead of stretching across the page', () => {
    renderWithProviders(<ReceptionTabs />, { initialEntries: ['/reception'] })

    const track = screen.getByRole('tablist').parentElement
    expect(track?.className).toContain('w-fit')
    expect(track?.className).toContain('max-w-full')
    expect(track?.className).not.toContain('max-sm:w-full')
  })

  it('scrolls only the tab list (never the page) to show the selected tab when the tabs overflow', async () => {
    const { user } = renderWithProviders(<ReceptionTabs />, { initialEntries: ['/reception'] })
    const list = screen.getByRole('tablist')
    // jsdom has no layout: a 200 px wide list with four 120 px tabs.
    Object.defineProperties(list, { clientWidth: { value: 200 }, scrollWidth: { value: 480 } })
    screen.getAllByRole('tab').forEach((tab, index) => {
      Object.defineProperties(tab, { offsetLeft: { value: index * 120 }, offsetWidth: { value: 120 } })
    })

    await user.click(getTab(/Walk-in/))
    expect(list.scrollLeft).toBe(280) // 360 + 120 - 200: the last tab's end at the list's end

    await user.click(getTab('Scan'))
    expect(list.scrollLeft).toBe(0)
  })
})
