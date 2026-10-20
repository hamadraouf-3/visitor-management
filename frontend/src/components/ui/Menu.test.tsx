import { act, screen, within } from '@testing-library/react'
import { Archive } from 'lucide-react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deferred } from '../../test/api'
import { renderWithProviders } from '../../test/render'
import { Menu, type MenuControl, type MenuItem } from './Menu'

/** Lets a load that was settled reach the menu. */
async function settle() {
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
}

function renderMenu({ onArchive = vi.fn<() => void>(), header }: { onArchive?: () => void; header?: string } = {}) {
  const items: MenuItem[] = [
    { id: 'profile', label: 'Profile', to: '/profile' },
    { id: 'archive', label: 'Archive', onSelect: onArchive },
    { id: 'delete', label: 'Delete', onSelect: () => {}, tone: 'danger' },
  ]
  const view = renderWithProviders(
    <div>
      <Menu items={items} trigger="Actions" header={header} />
      <button type="button">Elsewhere</button>
    </div>,
  )
  return { ...view, trigger: screen.getByRole('button', { name: 'Actions' }) }
}

describe('Menu', () => {
  it('is named by its trigger', async () => {
    const { user, trigger } = renderMenu()

    await user.click(trigger)

    const menu = screen.getByRole('menu', { name: 'Actions' })
    expect(menu).toHaveAttribute('aria-labelledby', trigger.id)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(trigger).toHaveAttribute('aria-controls', menu.id)
  })

  it('takes its name from the trigger label when the trigger has no text', async () => {
    const { user } = renderWithProviders(
      <Menu items={[{ id: 'a', label: 'Sign out', onSelect: () => {} }]} trigger={<span aria-hidden="true">LH</span>} triggerLabel="Account menu for Lina Haddad" />,
    )

    await user.click(screen.getByRole('button', { name: 'Account menu for Lina Haddad' }))

    expect(screen.getByRole('menu', { name: 'Account menu for Lina Haddad' })).toBeInTheDocument()
  })

  it('renders the header next to the menu, not inside it, so it is never a menu child', async () => {
    const { user, trigger } = renderMenu({ header: 'Signed in as Lina Haddad' })

    await user.click(trigger)

    const menu = screen.getByRole('menu')
    expect(screen.getByText('Signed in as Lina Haddad')).toBeVisible()
    expect(within(menu).queryByText('Signed in as Lina Haddad')).toBeNull()
    // Every child of the menu is a menu item.
    expect(Array.from(menu.children).map((child) => child.getAttribute('role'))).toEqual(['menuitem', 'menuitem', 'menuitem'])
    // Arrow keys move through the items only.
    expect(within(menu).getByRole('menuitem', { name: 'Profile' })).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toHaveFocus()
  })

  it('opens from the keyboard and moves with arrows, Home and End', async () => {
    const { user, trigger } = renderMenu()
    trigger.focus()

    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Profile' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus()
    await user.keyboard('{Home}')
    expect(screen.getByRole('menuitem', { name: 'Profile' })).toHaveFocus()
  })

  it('runs an action, closes and returns focus to the trigger', async () => {
    const onArchive = vi.fn<() => void>()
    const { user, trigger } = renderMenu({ onArchive })

    await user.click(trigger)
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }))

    expect(onArchive).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('closes on Escape (focus back on the trigger), on Tab and on an outside click', async () => {
    const { user, trigger } = renderMenu()

    await user.click(trigger)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await user.tab()
    expect(screen.queryByRole('menu')).toBeNull()

    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).not.toHaveAttribute('aria-controls')
  })

  it('moves on from the item that has the focus, also when a pointer put it there', async () => {
    const { user, trigger } = renderMenu()

    await user.click(trigger)
    expect(screen.getByRole('menuitem', { name: 'Profile' })).toHaveFocus()
    // A pointer pressed Delete (its focus, without choosing): the arrows go on from there.
    screen.getByRole('menuitem', { name: 'Delete' }).focus()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toHaveFocus()
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Profile' })).toHaveFocus()
  })

  it('opens an address outside the app in a new tab, says so to a screen reader, and returns the focus to the trigger', async () => {
    const { user } = renderWithProviders(<Menu items={[{ id: 'google', label: 'Google Calendar', href: 'https://calendar.google.com/calendar/render?action=TEMPLATE' }]} trigger="Add to my calendar" fitContent />)
    const trigger = screen.getByRole('button', { name: 'Add to my calendar' })

    await user.click(trigger)
    const item = screen.getByRole('menuitem', { name: 'Google Calendar (opens in a new tab)' })
    expect(item.tagName).toBe('A')
    expect(item).toHaveAttribute('href', 'https://calendar.google.com/calendar/render?action=TEMPLATE')
    expect(item).toHaveAttribute('target', '_blank')
    // No opener and no referrer: the new tab cannot reach this page or learn its address.
    expect(item).toHaveAttribute('rel', 'noopener noreferrer')
    expect(item).toHaveFocus()
    // As wide as its items, not as the trigger: no name wraps beside a narrow button.
    expect(screen.getByRole('menu').parentElement?.className).toContain('w-max')
    item.addEventListener('click', (event) => event.preventDefault())
    await user.click(item)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('chooses a link item with Space, as a button item, but not with the Space that opened the menu on it', async () => {
    const clicks: string[] = []
    const { user, router } = renderWithProviders(
      <Menu
        items={[
          { id: 'google', label: 'Google Calendar', href: 'https://calendar.google.com/calendar/render' },
          { id: 'profile', label: 'Profile', to: '/profile' },
          { id: 'archive', label: 'Archive', onSelect: () => clicks.push('archive') },
        ]}
        trigger="Actions"
      />,
    )
    const trigger = screen.getByRole('button', { name: 'Actions' })

    // Space on the trigger opens the menu on the link: its release there chooses nothing.
    trigger.focus()
    await user.keyboard(' ')
    const google = screen.getByRole('menuitem', { name: 'Google Calendar (opens in a new tab)' })
    expect(google).toHaveFocus()
    google.addEventListener('click', (event) => {
      clicks.push('google')
      event.preventDefault()
    })
    await user.keyboard(' ')
    expect(clicks).toEqual(['google'])
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).toHaveFocus()

    // A page of the app, with Space.
    await user.keyboard('{Enter}{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Profile' })).toHaveFocus()
    await user.keyboard(' ')
    expect(router.state.location.pathname).toBe('/profile')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('loads its items when it opens: busy meanwhile, then open on them', async () => {
    const load = deferred<readonly MenuItem[] | null>()
    const loadItems = vi.fn<() => Promise<readonly MenuItem[] | null>>(() => load.promise)
    const { user } = renderWithProviders(
      <div>
        <Menu trigger="Actions" triggerIcon={<Archive aria-hidden="true" data-icon="archive" />} loadItems={loadItems} />
        <button type="button">Elsewhere</button>
      </div>,
    )
    const trigger = screen.getByRole('button', { name: 'Actions' })
    expect(trigger.querySelector('[data-icon="archive"]')).not.toBeNull()

    trigger.focus()
    await user.keyboard('{ArrowUp}')
    // The kit's loading state: busy and unavailable, but still focused, the spinner in place of the icon;
    // a second press asks nothing more.
    expect(trigger).toHaveAttribute('aria-busy', 'true')
    expect(trigger).toHaveAttribute('aria-disabled', 'true')
    expect(trigger.querySelector('.animate-spin')).not.toBeNull()
    expect(trigger.querySelector('[data-icon="archive"]')).toBeNull()
    expect(trigger).toHaveFocus()
    await user.click(trigger)
    expect(loadItems).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()

    load.resolve([{ id: 'one', label: 'One', onSelect: () => {} }, { id: 'two', label: 'Two', onSelect: () => {} }])
    await settle()
    // ArrowUp opened it on the last of the items that came.
    expect(screen.getByRole('menuitem', { name: 'Two' })).toHaveFocus()
    expect(trigger).not.toHaveAttribute('aria-busy')
    expect(trigger).not.toHaveAttribute('aria-disabled')
    expect(trigger.querySelector('.animate-spin')).toBeNull()
    expect(trigger.querySelector('[data-icon="archive"]')).not.toBeNull()
  })

  it('opens nothing when the load brings nothing, fails, or is overtaken by Escape, a click outside or the focus leaving', async () => {
    let load = deferred<readonly MenuItem[] | null>()
    const { user } = renderWithProviders(
      <div>
        <Menu trigger="Actions" loadItems={() => load.promise} />
        <button type="button">Elsewhere</button>
      </div>,
    )
    const trigger = screen.getByRole('button', { name: 'Actions' })
    const item: MenuItem = { id: 'one', label: 'One', onSelect: () => {} }

    await user.click(trigger)
    load.resolve(null)
    await settle()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).not.toHaveAttribute('aria-busy')

    load = deferred()
    await user.click(trigger)
    load.reject(new Error('offline'))
    await settle()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).not.toHaveAttribute('aria-busy')

    for (const overtake of [() => user.keyboard('{Escape}'), () => user.click(screen.getByRole('button', { name: 'Elsewhere' })), () => user.tab()]) {
      load = deferred()
      trigger.focus()
      await user.keyboard('{Enter}')
      expect(trigger).toHaveAttribute('aria-busy', 'true')
      await overtake()
      expect(trigger).not.toHaveAttribute('aria-busy')
      load.resolve([item])
      await settle()
      expect(screen.queryByRole('menu')).toBeNull()
    }

    // Asked again, it opens.
    load = deferred()
    await user.click(trigger)
    load.resolve([item])
    await settle()
    expect(screen.getByRole('menuitem', { name: 'One' })).toHaveFocus()
  })

  it('closes from outside when its items went out of date: the focus back on the trigger, a load stopped', async () => {
    const control = createRef<MenuControl>()
    let load = deferred<readonly MenuItem[] | null>()
    const { user } = renderWithProviders(<Menu trigger="Actions" loadItems={() => load.promise} controlRef={control} />)
    const trigger = screen.getByRole('button', { name: 'Actions' })

    trigger.focus()
    await user.keyboard('{Enter}')
    load.resolve([{ id: 'one', label: 'One', onSelect: () => {} }])
    await settle()
    expect(screen.getByRole('menuitem', { name: 'One' })).toHaveFocus()
    act(() => control.current!.close())
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).toHaveFocus()

    // While its items load: the load opens nothing any more.
    load = deferred()
    await user.keyboard('{Enter}')
    expect(trigger).toHaveAttribute('aria-busy', 'true')
    act(() => control.current!.close())
    expect(trigger).not.toHaveAttribute('aria-busy')
    load.resolve([{ id: 'one', label: 'One', onSelect: () => {} }])
    await settle()
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('Menu: a held key', () => {
  // A link item's activation, wherever it comes from (a press, a key, the kit's own click).
  const followed: string[] = []
  const follow = (event: MouseEvent) => {
    if (!(event.target instanceof HTMLAnchorElement)) return
    followed.push(event.target.textContent ?? '')
    event.preventDefault()
  }
  afterEach(() => {
    document.removeEventListener('click', follow, true)
    followed.length = 0
  })

  it.each(['Space', 'Enter'])('chooses nothing when a held %s repeats on the first item it opened the menu on', async (key) => {
    document.addEventListener('click', follow, true)
    const onSelect = vi.fn<() => void>()
    const { user } = renderWithProviders(
      <div>
        <Menu items={[{ id: 'google', label: 'Google Calendar', href: 'https://calendar.google.com/calendar/render' }]} trigger="Calendars" />
        <Menu items={[{ id: 'archive', label: 'Archive', onSelect }]} trigger="Actions" />
      </div>,
    )

    // The OS repeats the keydown of a key held down; the first one opens the menu on its first item.
    for (const name of ['Calendars', 'Actions']) {
      const trigger = screen.getByRole('button', { name })
      trigger.focus()
      await user.keyboard(`[${key}>4/]`)
      const first = within(screen.getByRole('menu', { name })).getAllByRole('menuitem')[0]!
      expect(first).toHaveFocus()
      await user.keyboard('{Escape}')
    }
    expect(followed).toEqual([])
    expect(onSelect).not.toHaveBeenCalled()

    // A press of its own still chooses.
    await user.click(screen.getByRole('button', { name: 'Calendars' }))
    await user.keyboard(key === 'Space' ? ' ' : '{Enter}')
    expect(followed).toEqual(['Google Calendar'])
  })
})
