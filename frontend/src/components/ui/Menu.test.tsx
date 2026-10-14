import { screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '../../test/render'
import { Menu, type MenuEntry, type MenuItem } from './Menu'

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
})

function renderChoices({ dir = 'ltr' }: { dir?: 'ltr' | 'rtl' } = {}) {
  const chosen: string[] = []
  function Choices() {
    const [value, setValue] = useState('system')
    const entries: MenuEntry[] = [
      {
        id: 'appearance',
        type: 'radio-group',
        label: 'Appearance',
        value,
        options: [
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
          { value: 'system', label: 'System' },
        ],
        onValueChange: (next) => {
          chosen.push(next)
          setValue(next)
        },
      },
      { id: 'sign-out', label: 'Sign out', onSelect: () => {} },
    ]
    return <Menu items={entries} trigger="Account" />
  }
  const view = renderWithProviders(
    <div dir={dir}>
      <Choices />
    </div>,
  )
  return { ...view, chosen, trigger: screen.getByRole('button', { name: 'Account' }) }
}

const choice = (name: string) => screen.getByRole('menuitemradio', { name })

describe('Menu, with a group of choices (menuitemradio)', () => {
  it('is a named group of menuitemradio items, the chosen one checked, set apart from the items after it', async () => {
    const { user, trigger } = renderChoices()
    await user.click(trigger)
    const menu = screen.getByRole('menu')
    const group = within(menu).getByRole('group', { name: 'Appearance' })
    expect(within(group).getAllByRole('menuitemradio').map((item) => [item.textContent, item.getAttribute('aria-checked')])).toEqual([
      ['Light', 'false'],
      ['Dark', 'false'],
      ['System', 'true'],
    ])
    // Its name is read once, through the group: the visible words are hidden from the tree.
    expect(within(menu).getAllByText('Appearance').every((element) => element.getAttribute('aria-hidden') === 'true')).toBe(true)
    expect(within(menu).getByRole('separator')).toBeInTheDocument()
    // The arrows visit every choice, then the items after them.
    expect(choice('Light')).toHaveFocus()
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(choice('Light')).toHaveFocus()
  })

  it('chooses with a click and with Space, and stays open; Enter chooses, closes and returns focus', async () => {
    const { user, trigger, chosen } = renderChoices()
    await user.click(trigger)
    await user.click(choice('Dark'))
    expect(choice('Dark')).toHaveAttribute('aria-checked', 'true')
    expect(choice('System')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('menu')).toBeInTheDocument()

    choice('Light').focus()
    await user.keyboard(' ')
    expect(choice('Light')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menu')).toBeInTheDocument()

    await user.keyboard('{ArrowDown}{Enter}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).toHaveFocus()
    // One choice per activation: Space and Enter never also click.
    expect(chosen).toEqual(['dark', 'light', 'dark'])
  })

  it('moves between the choices with Left and Right in the reading direction, from wherever the pointer left the focus', async () => {
    const ltr = renderChoices()
    await ltr.user.click(ltr.trigger)
    await ltr.user.keyboard('{ArrowRight}')
    expect(choice('Dark')).toHaveFocus()
    await ltr.user.keyboard('{ArrowRight}{ArrowRight}')
    expect(choice('Light')).toHaveFocus()
    await ltr.user.keyboard('{ArrowLeft}')
    expect(choice('System')).toHaveFocus()
    // Left and Right mean nothing on an item outside the group.
    await ltr.user.keyboard('{End}{ArrowRight}')
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toHaveFocus()
    // A pointer put the focus on Dark: the arrows go on from there.
    await ltr.user.click(choice('Dark'))
    await ltr.user.keyboard('{ArrowDown}')
    expect(choice('System')).toHaveFocus()
    ltr.unmount()

    const rtl = renderChoices({ dir: 'rtl' })
    await rtl.user.click(rtl.trigger)
    // In right-to-left text the next choice lies to the left.
    await rtl.user.keyboard('{ArrowLeft}')
    expect(choice('Dark')).toHaveFocus()
    await rtl.user.keyboard('{ArrowRight}')
    expect(choice('Light')).toHaveFocus()
  })
})
