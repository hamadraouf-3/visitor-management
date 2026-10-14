import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COPY_CONFIRMATION_MS, CopyButton } from './CopyButton'

const PASS_URL = 'https://visitors.example.com/pass#Xo3_vK9-aQ2rT7mN4bL8cY1zW6eH5jP0sD-gF_uIk2A'

function stubClipboard(implementation: (text: string) => Promise<void>) {
  const writeText = vi.fn<(text: string) => Promise<void>>(implementation)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  return writeText
}

function stubExecCommand(result: boolean) {
  const execCommand = vi.fn<(command: string) => boolean>(() => result)
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
  return execCommand
}

async function press(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

describe('CopyButton', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard')
    Reflect.deleteProperty(document, 'execCommand')
    vi.useRealTimers()
  })

  it('copies with the Clipboard API, confirms visibly and announces it', async () => {
    const writeText = stubClipboard(() => Promise.resolve())
    const onCopied = vi.fn<() => void>()
    render(<CopyButton value={PASS_URL} label="Copy link" copiedLabel="Link copied" onCopied={onCopied} />)
    const status = screen.getByRole('status')
    expect(status).toBeEmptyDOMElement()

    await press('Copy link')

    expect(writeText).toHaveBeenCalledWith(PASS_URL)
    expect(onCopied).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Link copied' })).toBeInTheDocument()
    // The live region existed before the message was written into it.
    expect(screen.getByRole('status')).toBe(status)
    expect(status).toHaveTextContent('Link copied')
  })

  it('returns to its idle label after the confirmation period', async () => {
    vi.useFakeTimers()
    stubClipboard(() => Promise.resolve())
    render(<CopyButton value={PASS_URL} label="Copy link" copiedLabel="Link copied" />)

    await press('Copy link')
    act(() => {
      vi.advanceTimersByTime(COPY_CONFIRMATION_MS)
    })

    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('falls back to a selection copy when the Clipboard API is refused, keeping focus on the button', async () => {
    stubClipboard(() => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError')))
    const execCommand = stubExecCommand(true)
    render(<CopyButton value={PASS_URL} label="Copy link" copiedLabel="Link copied" />)
    const button = screen.getByRole('button', { name: 'Copy link' })
    button.focus()

    await press('Copy link')

    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(screen.getByRole('button', { name: 'Link copied' })).toHaveFocus()
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('uses the selection copy where the Clipboard API does not exist (plain http on the LAN)', async () => {
    const execCommand = stubExecCommand(true)
    render(<CopyButton value={PASS_URL} />)

    await press('Copy')

    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(screen.getByRole('status')).toHaveTextContent('Copied')
  })

  it('tells the user to copy manually when no copy method works', async () => {
    stubExecCommand(false)
    const onCopied = vi.fn<() => void>()
    render(<CopyButton value={PASS_URL} label="Copy link" onCopied={onCopied} />)

    await press('Copy link')

    expect(screen.getByRole('status')).toHaveTextContent('Could not copy automatically. Select the text and copy it manually.')
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument()
    expect(onCopied).not.toHaveBeenCalled()
  })
})
