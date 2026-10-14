import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { useRovingToolbar } from './useRovingToolbar'

/** A toolbar between two other controls, as a text's variables stand between the text and what follows. */
function Bar({ names }: { names: string[] }) {
  const toolbar = useRovingToolbar(names.length)
  return (
    <>
      <button type="button">Before</button>
      <div {...toolbar.toolbarProps} aria-label="Tools">
        {names.map((name, index) => (
          <button key={name} type="button" {...toolbar.itemProps(index)}>
            {name}
          </button>
        ))}
      </div>
      <button type="button">After</button>
    </>
  )
}

const tool = (name: string) => screen.getByRole('button', { name })

/*
 * The variables of an e-mail text were eight tab stops after every one of fourteen texts: 138 presses
 * of Tab from the first text to the Save button (UX review M6). A toolbar is one stop (WAI-ARIA APG).
 */
describe('useRovingToolbar', () => {
  afterEach(() => {
    document.documentElement.dir = 'ltr'
  })

  it('makes the row one tab stop', async () => {
    const user = userEvent.setup()
    render(<Bar names={['One', 'Two', 'Three']} />)
    expect(screen.getByRole('toolbar', { name: 'Tools' })).toBeInTheDocument()
    expect(['One', 'Two', 'Three'].map((name) => tool(name).getAttribute('tabindex'))).toEqual(['0', '-1', '-1'])

    tool('Before').focus()
    await user.tab()
    expect(tool('One')).toHaveFocus()
    await user.tab()
    expect(tool('After')).toHaveFocus()
  })

  it('moves with the arrow keys and wraps, and jumps with Home and End', async () => {
    const user = userEvent.setup()
    render(<Bar names={['One', 'Two', 'Three']} />)
    tool('One').focus()
    await user.keyboard('{ArrowRight}')
    expect(tool('Two')).toHaveFocus()
    await user.keyboard('{ArrowRight}{ArrowRight}')
    expect(tool('One')).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(tool('Three')).toHaveFocus()
    await user.keyboard('{Home}')
    expect(tool('One')).toHaveFocus()
    await user.keyboard('{End}')
    expect(tool('Three')).toHaveFocus()
    // Keys the toolbar does not use are left alone (Enter and Space press the button).
    await user.keyboard('{ArrowDown}')
    expect(tool('Three')).toHaveFocus()
  })

  it('comes back to the control that was focused last', async () => {
    const user = userEvent.setup()
    render(<Bar names={['One', 'Two', 'Three']} />)
    tool('One').focus()
    await user.keyboard('{ArrowRight}')
    await user.tab()
    expect(tool('After')).toHaveFocus()
    expect(['One', 'Two', 'Three'].map((name) => tool(name).getAttribute('tabindex'))).toEqual(['-1', '0', '-1'])
    await user.tab({ shift: true })
    expect(tool('Two')).toHaveFocus()
  })

  it('mirrors the arrow keys in right-to-left text: Left is the next control', async () => {
    document.documentElement.dir = 'rtl'
    const user = userEvent.setup()
    render(<Bar names={['One', 'Two', 'Three']} />)
    tool('One').focus()
    await user.keyboard('{ArrowLeft}')
    expect(tool('Two')).toHaveFocus()
    await user.keyboard('{ArrowRight}{ArrowRight}')
    expect(tool('Three')).toHaveFocus()
    // Home and End follow the reading order, not the side.
    await user.keyboard('{Home}')
    expect(tool('One')).toHaveFocus()
  })

  it('keeps a tab stop when the row loses controls', async () => {
    const user = userEvent.setup()
    const view = render(<Bar names={['One', 'Two', 'Three']} />)
    tool('One').focus()
    await user.keyboard('{End}')
    view.rerender(<Bar names={['One', 'Two']} />)
    expect(['One', 'Two'].map((name) => tool(name).getAttribute('tabindex'))).toEqual(['-1', '0'])
  })
})
